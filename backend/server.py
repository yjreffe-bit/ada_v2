import sys
import asyncio

# Fix for asyncio subprocess support on Windows
# MUST BE SET BEFORE OTHER IMPORTS
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import logging
import socketio
import uvicorn
import webbrowser
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from oauth_connections import OAuthError, callback_page, manager, redirect_uris, redact_secrets_in_text
import asyncio
import threading
import sys
import os
import json
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path



# Ensure we can import ada
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import ada
from authenticator import FaceAuthenticator
from kasa_agent import KasaAgent
from token_store import TokenStore
from gemini_key_store import GeminiKeyStore
from studio_service import (
    FilmJob,
    FilmLibrary,
    MemoryBook,
    dispatch_local_tool,
    form_from_request,
    sweety_reply_fallback,
    warning_for,
)
import mobile_behavior
from fastapi.responses import FileResponse

# Create a Socket.IO server
import re


class LocalhostCORS:
    def __call__(self, origin):
        if origin is None:
            return False
        return bool(re.match(r"https?://(localhost|127\.0\.0\.1)(:\d+)?$", origin))


def log_origin_middleware(app):
    async def middleware(scope, receive, send):
        if 'headers' in scope:
            for key, value in scope['headers']:
                if key == b'origin':
                    print(f"[SOCKETIO] Incoming Origin: {value.decode()}")
                    break
        await app(scope, receive, send)

    return middleware


sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins=LocalhostCORS())
app = None
app_socketio = None

import signal

# --- SHUTDOWN HANDLER ---
def signal_handler(sig, frame):
    print(f"\n[SERVER] Caught signal {sig}. Exiting gracefully...")
    # Clean up audio loop
    if audio_loop:
        try:
            print("[SERVER] Stopping Audio Loop...")
            audio_loop.stop() 
        except:
            pass
    # Force kill
    print("[SERVER] Force exiting...")
    os._exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# Global state
audio_loop = None
loop_task = None
authenticator = None
kasa_agent = KasaAgent()
SETTINGS_FILE = "settings.json"
STARTUP_CHECKS = {
    "ready": None,
    "summary": "Startup checks pending.",
    "issues": [],
}
STARTUP_REFRESH_INTERVAL_SECONDS = 45
_LAST_STARTUP_REFRESH_TS = 0.0

DEFAULT_SETTINGS = {
    "face_auth_enabled": False, # Default OFF as requested
    "tool_permissions": {
        "generate_cad": True,
        "run_web_agent": True,
        "write_file": True,
        "read_directory": True,
        "read_file": True,
        "create_project": True,
        "switch_project": True,
        "list_projects": True
    },
    "printers": [], # List of {host, port, name, type}
    "kasa_devices": [], # List of {ip, alias, model}
    "camera_flipped": False, # Invert cursor horizontal direction
    # Same string ADA speaks with. A local settings.json can still override it.
    "ada_personality": ada.DEFAULT_PERSONALITY,
    "voice_name": "Kore",
    "live_model": "gemini-3.8-live",
    "text_model": "gemini-3.8-flash",
    "google_search": True,
    "assistant_look": "sweety",
}

SETTINGS = DEFAULT_SETTINGS.copy()

def load_settings():
    global SETTINGS
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r') as f:
                loaded = json.load(f)
                # Merge with defaults to ensure new keys exist
                # Deep merge for tool_permissions would be better but shallow merge of top keys + tool_permissions check is okay for now
                for k, v in loaded.items():
                    if k == "tool_permissions" and isinstance(v, dict):
                         SETTINGS["tool_permissions"].update(v)
                    else:
                        SETTINGS[k] = v
            print(f"Loaded settings: {SETTINGS}")
        except Exception as e:
            print(f"Error loading settings: {e}")

def save_settings():
    try:
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(SETTINGS, f, indent=4)
        print("Settings saved.")
    except Exception as e:
        print(f"Error saving settings: {e}")

# Load on startup
load_settings()

authenticator = None
kasa_agent = KasaAgent(known_devices=SETTINGS.get("kasa_devices"))
MAIN_LOOP = None


def _env_gemini_keys():
    keys = []
    primary = os.getenv("GEMINI_API_KEY", "").strip()
    if primary and primary != "DUMMY_KEY":
        keys.append(primary)
    for part in os.getenv("GEMINI_API_KEY_FALLBACKS", "").split(","):
        if part.strip():
            keys.append(part.strip())
    return keys


_token_store = TokenStore()
gemini_keys = GeminiKeyStore(_token_store, env_keys=_env_gemini_keys())
memory_book = MemoryBook(_token_store)
film_library = FilmLibrary()
film_job = FilmJob(gemini_keys, film_library)


def emit_from_thread(event, payload):
    loop = MAIN_LOOP
    if loop and loop.is_running():
        asyncio.run_coroutine_threadsafe(sio.emit(event, payload), loop)


film_job.listeners.append(lambda snapshot: emit_from_thread("film_status", snapshot))


def _apply_active_gemini_key():
    entries = gemini_keys._rotator._entries
    if not entries:
        return
    key = entries[0]["key"]
    os.environ["GEMINI_API_KEY"] = key
    ada.client = ada.genai.Client(http_options={"api_version": "v1beta"}, api_key=key)


_apply_active_gemini_key()


def _schedule_notice(delay, message):
    async def _fire():
        await asyncio.sleep(max(0, delay))
        await sio.emit("status", {"msg": message})
        await sio.emit("transcription", {"sender": "System", "text": message})

    loop = MAIN_LOOP
    if loop and loop.is_running():
        asyncio.run_coroutine_threadsafe(_fire(), loop)


async def handle_mobile_tool(name, args):
    local = dispatch_local_tool(name, args, memory_book, _schedule_notice)
    if local is not None:
        if name in {"look_at_screen", "share_screen", "see_screen"}:
            await sio.emit("screen_share_request", {"tool": name})
        if name in {"save_memory", "delete_memory"}:
            await sio.emit("memories", memory_book.list_notes())
        return local
    if name == "list_kasa_devices":
        devices = await kasa_agent.discover_devices()
        await sio.emit("kasa_devices", devices)
        return f"Found {len(devices)} Kasa devices."
    if name == "set_kasa_power":
        target = (args or {}).get("target") or ""
        power = str((args or {}).get("power") or "").lower()
        action = "on" if power in {"on", "true", "1"} else "off"
        device = kasa_agent._resolve_device(target) if hasattr(kasa_agent, "_resolve_device") else None
        ip = getattr(device, "host", None) or target
        success = await (kasa_agent.turn_on(ip) if action == "on" else kasa_agent.turn_off(ip))
        await sio.emit("kasa_update", {"ip": ip, "is_on": action == "on"})
        return "The device is on, Sir." if success and action == "on" else "The device is off, Sir." if success else f"Could not reach {target}."
    if name == "generate_finished_video":
        form = form_from_request((args or {}).get("request") or "")
        result = film_job.start_form(form)
        await sio.emit("open_content", {"form": form, "line": result.get("line") or result.get("message"), "warning": warning_for(form["minutes"])})
        return result.get("line") or result.get("message")
    if name == "generate_scene_video":
        prompt = ((args or {}).get("prompt") or "").strip()
        if len(prompt) < 12:
            return "Describe the scene in a sentence, Sir."
        form = {
            "niche": "Storytelling",
            "style": "Cinematic",
            "aspect": (args or {}).get("aspect") or "9:16",
            "narrator": "Storyteller",
            "minutes": 1,
            "topic": prompt,
            "max_scenes": 1,
            "crossfade": False,
            "captions": False,
            "voiceover": False,
        }
        result = film_job.start_form(form)
        await sio.emit("open_scene", {"prompt": prompt, "line": result.get("line") or result.get("message")})
        return result.get("line") or result.get("message")
    if name == "ask_sweety":
        message = (args or {}).get("message") or ""
        reply = await asyncio.to_thread(_sweety_text, message)
        make = "[[MAKE_IT]]" in reply or mobile_behavior.wants_make_it(message)
        clean = reply.replace("[[MAKE_IT]]", "").strip()
        await sio.emit("sweety_line", {"role": "Sweety", "text": clean, "make": make})
        if make:
            form = form_from_request(message)
            form["max_scenes"] = 3
            result = film_job.start_form(form)
            return result.get("line") or clean
        return clean
    return "Done."


def handle_mobile_tool_memory():
    return memory_book.prompt_block()


handle_mobile_tool.memory_block = handle_mobile_tool_memory
ada.mobile_tool_handler = handle_mobile_tool


def _sweety_text(message):
    if not (message or "").strip():
        return "Say something to Sweety first."
    try:
        acquired = gemini_keys.acquire()
    except RuntimeError:
        return sweety_reply_fallback(message)
    from omni_film import _post_json
    from provider_http import http_request
    model = mobile_behavior.migrate_text_model(SETTINGS.get("text_model"))
    result = _post_json(
        http_request,
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        acquired["key"],
        {"contents": [{"role": "user", "parts": [{"text": mobile_behavior.sweety_prompt() + "\n\n" + message}]}]},
        60,
    )
    if result.status >= 400:
        if result.status in {401, 403, 429, 500, 502, 503, 504}:
            gemini_keys.cool(acquired["slot"])
        return sweety_reply_fallback(message)
    data = result.json()
    parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
    text = "".join(part.get("text") or "" for part in parts).strip()
    return text or sweety_reply_fallback(message)
# tool_permissions is now SETTINGS["tool_permissions"]


def _is_quota_error(message):
    if not message:
        return False
    lowered = message.lower()
    return (
        "exceeded your current quota" in lowered
        or "resource_exhausted" in lowered
        or "check your plan and billing" in lowered
        or "quota exceeded" in lowered
    )


def _build_local_fallback_reply(user_text, failure_reason):
    printer_count = len(SETTINGS.get("printers", []))
    kasa_count = len(SETTINGS.get("kasa_devices", []))
    face_auth_enabled = SETTINGS.get("face_auth_enabled", False)
    reason_text = (failure_reason or "").lower()

    if _is_quota_error(failure_reason):
        cloud_issue = "Gemini cloud quota for this API key is currently exhausted, so live voice and full AI chat are unavailable."
    elif "expired" in reason_text:
        cloud_issue = "Gemini API key appears expired, so live voice and full AI chat are unavailable."
    else:
        cloud_issue = "Gemini cloud connection is currently unavailable, so live voice and full AI chat are unavailable."

    summary = [
        "Sir, ADA is running in local maintenance mode.",
        cloud_issue,
        f"Core status: face auth {'enabled' if face_auth_enabled else 'disabled'}, {printer_count} saved printer(s), {kasa_count} saved smart device(s).",
    ]
    try:
        from oauth_connections import connection_summary
        summary.append(connection_summary())
    except Exception as exc:
        print(f"[OAUTH] Could not read connection status: {exc}")

    lowered = (user_text or "").lower()
    if any(word in lowered for word in ["status", "health", "check", "diagnose", "why"]):
        summary.append(f"Detected backend issue: {failure_reason}")
    elif any(word in lowered for word in ["help", "what can you do", "capabilities"]):
        summary.append("I can still report system state, surface backend errors, and keep local ADA controls available while the API quota is restored.")
    else:
        summary.append(f"I received your message: '{user_text}'. Restore Gemini billing or quota to re-enable full ADA replies.")

    summary.append("Action required: add Gemini billing or wait for quota reset, then restart ADA.")
    return " ".join(summary)


def _text_fallback_available():
    candidates = STARTUP_CHECKS.get("candidates") or []
    return any(candidate.get("text_ok") for candidate in candidates if isinstance(candidate, dict))


async def _emit_pcm_audio_chunks(pcm_bytes, chunk_size=2048):
    if not pcm_bytes:
        return
    for offset in range(0, len(pcm_bytes), chunk_size):
        chunk = pcm_bytes[offset:offset + chunk_size]
        await sio.emit('audio_data', {'data': list(chunk)})
        await asyncio.sleep(0)


async def _deliver_tts_fallback_audio(text):
    try:
        tts_pcm = await ada.synthesize_tts_audio(text, max_retries=3)
        await _emit_pcm_audio_chunks(tts_pcm)
        await asyncio.to_thread(ada.play_pcm_audio, tts_pcm)
        return True
    except Exception as exc:
        print(f"[SERVER] TTS fallback failed: {exc}")
        return False


async def _maybe_refresh_startup_checks(force=False):
    global STARTUP_CHECKS, _LAST_STARTUP_REFRESH_TS

    now = time.time()
    if not force and (now - _LAST_STARTUP_REFRESH_TS) < STARTUP_REFRESH_INTERVAL_SECONDS:
        return STARTUP_CHECKS

    try:
        updated = await ada.refresh_provider_preflight(force=True)
        STARTUP_CHECKS = updated
        _LAST_STARTUP_REFRESH_TS = now
        await sio.emit('startup_checks', STARTUP_CHECKS)
    except Exception as exc:
        print(f"[SERVER] Startup-check refresh failed: {exc}")

    return STARTUP_CHECKS

async def _run_startup_initialization():
    global STARTUP_CHECKS, _LAST_STARTUP_REFRESH_TS
    import sys
    print(f"[SERVER DEBUG] Startup Event Triggered")
    print(f"[SERVER DEBUG] Python Version: {sys.version}")
    try:
        loop = asyncio.get_running_loop()
        print(f"[SERVER DEBUG] Running Loop: {type(loop)}")
        policy = asyncio.get_event_loop_policy()
        print(f"[SERVER DEBUG] Current Policy: {type(policy)}")
    except Exception as e:
        print(f"[SERVER DEBUG] Error checking loop: {e}")

    print("[SERVER] Startup: Initializing Kasa Agent...")
    await kasa_agent.initialize()
    STARTUP_CHECKS = await ada.refresh_provider_preflight(force=True)
    _LAST_STARTUP_REFRESH_TS = time.time()
    print(f"[SERVER] Provider preflight: {STARTUP_CHECKS.get('summary')}")
    for redirect in redirect_uris():
        print(f"[OAUTH] Register this redirect URL: {redirect}")


@asynccontextmanager
async def lifespan(_app):
    global MAIN_LOOP
    MAIN_LOOP = asyncio.get_running_loop()
    await _run_startup_initialization()
    yield


app = FastAPI(lifespan=lifespan)
app_socketio = log_origin_middleware(socketio.ASGIApp(sio, app))


class _OAuthLogFilter(logging.Filter):
    def filter(self, record):
        try:
            message = record.getMessage()
        except Exception:
            return True
        redacted = redact_secrets_in_text(message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


for _logger_name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    logging.getLogger(_logger_name).addFilter(_OAuthLogFilter())

@app.get("/status")
async def status():
    return {"status": "running", "service": "A.D.A Backend"}


@app.get("/media/ada/{name}")
async def media_ada(name: str):
    safe_name = Path(name).name
    root = film_library.directory.resolve()
    path = (root / safe_name).resolve()
    if path.parent != root or not path.is_file():
        return HTMLResponse("missing", status_code=404)
    return FileResponse(path)


@app.get("/oauth/{provider}/callback", response_class=HTMLResponse)
async def oauth_callback(provider: str, request: Request):
    # The authorization code in the query is a secret. Do not log request.url.
    try:
        result = await asyncio.to_thread(manager().finish, provider, dict(request.query_params))
    except OAuthError as exc:
        return HTMLResponse(callback_page("ADA login failed", str(exc)), status_code=400)
    try:
        await sio.emit("connections", manager().public_status())
    except Exception:
        print("[OAUTH] Could not refresh the Connections panel.")
    return HTMLResponse(callback_page("ADA connected", result["message"]))


@app.get("/startup-checks")
async def startup_checks():
    return STARTUP_CHECKS

@sio.event
async def connect(sid, environ):
    print(f"Client connected: {sid}")
    await _maybe_refresh_startup_checks(force=False)
    await sio.emit('status', {'msg': 'Connected to A.D.A Backend'}, room=sid)
    await sio.emit('startup_checks', STARTUP_CHECKS, room=sid)
    await sio.emit('gemini_keys', gemini_keys.public_view(), room=sid)
    await sio.emit('memories', memory_book.list_notes(), room=sid)

    global authenticator
    
    # Callback for Auth Status
    async def on_auth_status(is_auth):
        print(f"[SERVER] Auth status change: {is_auth}")
        await sio.emit('auth_status', {'authenticated': is_auth})

    # Callback for Auth Camera Frames
    async def on_auth_frame(frame_b64):
        await sio.emit('auth_frame', {'image': frame_b64})

    # Initialize Authenticator if not already done
    if authenticator is None:
        authenticator = FaceAuthenticator(
            reference_image_path="reference.jpg",
            on_status_change=on_auth_status,
            on_frame=on_auth_frame
        )
    
    # Check if already authenticated or needs to start
    if authenticator.authenticated:
        await sio.emit('auth_status', {'authenticated': True})
    else:
        # Check Settings for Auth
        if SETTINGS.get("face_auth_enabled", False):
            await sio.emit('auth_status', {'authenticated': False})
            # Start the auth loop in background
            asyncio.create_task(authenticator.start_authentication_loop())
        else:
            # Bypass Auth
            print("Face Auth Disabled. Auto-authenticating.")
            # We don't change authenticator state to true to avoid confusion if re-enabled? 
            # Or we should just tell client it's auth'd.
            await sio.emit('auth_status', {'authenticated': True})

@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")


@sio.event
async def get_startup_checks(sid):
    await _maybe_refresh_startup_checks(force=False)
    await sio.emit('startup_checks', STARTUP_CHECKS, room=sid)


async def _start_audio_loop(data=None):
    global audio_loop, loop_task

    print("Starting Audio Loop...")

    device_index = None
    device_name = None
    start_muted = False
    if data:
        if 'device_index' in data:
            device_index = data['device_index']
        if 'device_name' in data:
            device_name = data['device_name']
        start_muted = data.get('muted', False)

    print(f"Using input device: Name='{device_name}', Index={device_index}")

    def on_audio_data(data_bytes):
        asyncio.create_task(sio.emit('audio_data', {'data': list(data_bytes)}))

    def on_cad_data(data):
        info = f"{len(data.get('vertices', []))} vertices" if 'vertices' in data else f"{len(data.get('data', ''))} bytes (STL)"
        print(f"Sending CAD data to frontend: {info}")
        asyncio.create_task(sio.emit('cad_data', data))

    def on_web_data(data):
        print(f"Sending Browser data to frontend: {len(data.get('log', ''))} chars logs")
        asyncio.create_task(sio.emit('browser_frame', data))

    def on_transcription(data):
        asyncio.create_task(sio.emit('transcription', data))

    def on_tool_confirmation(data):
        print(f"Requesting confirmation for tool: {data.get('tool')}")
        asyncio.create_task(sio.emit('tool_confirmation_request', data))

    def on_cad_status(status):
        if isinstance(status, dict):
            print(f"Sending CAD Status: {status.get('status')} (attempt {status.get('attempt')}/{status.get('max_attempts')})")
            asyncio.create_task(sio.emit('cad_status', status))
        else:
            print(f"Sending CAD Status: {status}")
            asyncio.create_task(sio.emit('cad_status', {'status': status}))

    def on_cad_thought(thought_text):
        asyncio.create_task(sio.emit('cad_thought', {'text': thought_text}))

    def on_project_update(project_name):
        print(f"Sending Project Update: {project_name}")
        asyncio.create_task(sio.emit('project_update', {'project': project_name}))

    def on_device_update(devices):
        print(f"Sending Kasa Device Update: {len(devices)} devices")
        asyncio.create_task(sio.emit('kasa_devices', devices))

    def on_error(msg):
        print(f"Sending Error to frontend: {msg}")
        asyncio.create_task(sio.emit('error', {'msg': msg}))

    def on_playback_level(level):
        asyncio.create_task(sio.emit('playback_level', {'level': level}))

    print(f"Initializing AudioLoop with device_index={device_index}")
    audio_loop = ada.AudioLoop(
        video_mode="none",
        on_audio_data=on_audio_data,
        on_cad_data=on_cad_data,
        on_web_data=on_web_data,
        on_transcription=on_transcription,
        on_tool_confirmation=on_tool_confirmation,
        on_cad_status=on_cad_status,
        on_cad_thought=on_cad_thought,
        on_project_update=on_project_update,
        on_device_update=on_device_update,
        on_error=on_error,
        on_playback_level=on_playback_level,
        input_device_index=device_index,
        input_device_name=device_name,
        kasa_agent=kasa_agent
    )
    print("AudioLoop initialized successfully.")

    audio_loop.update_permissions(SETTINGS["tool_permissions"])

    if start_muted:
        print("Starting with Audio Paused")
        audio_loop.set_paused(True)

    print("Creating asyncio task for AudioLoop.run()")
    loop_task = asyncio.create_task(audio_loop.run())

    def handle_loop_exit(task):
        try:
            task.result()
        except asyncio.CancelledError:
            print("Audio Loop Cancelled")
        except Exception as e:
            print(f"Audio Loop Crashed: {e}")

    loop_task.add_done_callback(handle_loop_exit)

    print("Emitting 'A.D.A Started'")
    await sio.emit('status', {'msg': 'A.D.A Started'})

    saved_printers = SETTINGS.get("printers", [])
    if saved_printers and audio_loop.printer_agent:
        print(f"[SERVER] Loading {len(saved_printers)} saved printers...")
        for p in saved_printers:
            audio_loop.printer_agent.add_printer_manually(
                name=p.get("name", p["host"]),
                host=p["host"],
                port=p.get("port", 80),
                printer_type=p.get("type", "moonraker"),
                camera_url=p.get("camera_url")
            )

    asyncio.create_task(monitor_printers_loop())


async def ensure_audio_session(data=None, timeout=8.0):
    global audio_loop, loop_task

    if audio_loop and audio_loop.session:
        return True

    if audio_loop and getattr(audio_loop, 'live_session_supported', True) is False:
        print("[SERVER] Live session already marked unsupported. Using text fallback.")
        return False

    await _maybe_refresh_startup_checks(force=False)
    if STARTUP_CHECKS.get("ready") is False and _text_fallback_available():
        print("[SERVER] Live preflight is not ready, but text fallback is available. Skipping audio session startup.")
        return False

    if audio_loop and loop_task and (loop_task.done() or loop_task.cancelled()):
        print("Audio loop task finished before session became ready. Resetting...")
        audio_loop = None
        loop_task = None

    if not audio_loop:
        await _start_audio_loop(data)

    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if audio_loop and audio_loop.session:
            return True
        if audio_loop and getattr(audio_loop, 'last_connection_error', None):
            print(f"[SERVER] Audio session startup failed: {audio_loop.last_connection_error}")
            return False
        if loop_task and loop_task.done():
            break
        await asyncio.sleep(0.1)

    print("[SERVER] Audio session did not become ready before timeout.")
    return False

@sio.event
async def start_audio(sid, data=None):
    global audio_loop, loop_task

    await _maybe_refresh_startup_checks(force=False)

    if STARTUP_CHECKS.get("ready") is False and _text_fallback_available():
        print("[SERVER] Skipping start_audio because live mode is unavailable and text fallback is active.")
        await sio.emit('status', {'msg': 'Text Fallback Mode'})
        return
    
    # Optional: Block if not authenticated
    # Only block if auth is ENABLED and not authenticated
    if SETTINGS.get("face_auth_enabled", False):
        if authenticator and not authenticator.authenticated:
            print("Blocked start_audio: Not authenticated.")
            await sio.emit('error', {'msg': 'Authentication Required'})
            return

    if audio_loop:
        if loop_task and (loop_task.done() or loop_task.cancelled()):
             print("Audio loop task appeared finished/cancelled. Clearing and restarting...")
             audio_loop = None
             loop_task = None
        else:
             print("Audio loop already running. Re-connecting client to session.")
             await sio.emit('status', {'msg': 'A.D.A Already Running'})
             return
    try:
        await _start_audio_loop(data)
    except Exception as e:
        print(f"CRITICAL ERROR STARTING ADA: {e}")
        import traceback
        traceback.print_exc()
        await sio.emit('error', {'msg': f"Failed to start: {str(e)}"})
        audio_loop = None # Ensure we can try again


async def monitor_printers_loop():
    """Background task to query printer status periodically."""
    print("[SERVER] Starting Printer Monitor Loop")
    while audio_loop and audio_loop.printer_agent:
        try:
            agent = audio_loop.printer_agent
            if not agent.printers:
                await asyncio.sleep(5)
                continue
                
            tasks = []
            for host, printer in agent.printers.items():
                if printer.printer_type.value != "unknown":
                    tasks.append(agent.get_print_status(host))
            
            if tasks:
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for res in results:
                    if isinstance(res, Exception):
                        pass # Ignore errors for now
                    elif res:
                        # res is PrintStatus object
                        await sio.emit('print_status_update', res.to_dict())
                        
        except asyncio.CancelledError:
            print("[SERVER] Printer Monitor Cancelled")
            break
        except Exception as e:
            print(f"[SERVER] Monitor Loop Error: {e}")
            
        await asyncio.sleep(2) # Update every 2 seconds for responsiveness

@sio.event
async def stop_audio(sid):
    global audio_loop
    if audio_loop:
        audio_loop.stop() 
        print("Stopping Audio Loop")
        audio_loop = None
        await sio.emit('status', {'msg': 'A.D.A Stopped'})

@sio.event
async def pause_audio(sid):
    global audio_loop
    if audio_loop:
        audio_loop.set_paused(True)
        print("Pausing Audio")
        await sio.emit('status', {'msg': 'Audio Paused'})

@sio.event
async def resume_audio(sid):
    global audio_loop
    if audio_loop:
        audio_loop.set_paused(False)
        print("Resuming Audio")
        await sio.emit('status', {'msg': 'Audio Resumed'})

@sio.event
async def video_frame(sid, data):
    global audio_loop
    if audio_loop:
        try:
            image_data = data.get('image')
            if not image_data:
                return
                
            if isinstance(image_data, bytes):
                # Socket.io automatically decodes native Javascript Blobs to Python bytes!
                payload = {
                    "mime_type": "image/jpeg",
                    "data": image_data
                }
            elif isinstance(image_data, str):
                import base64
                if ',' in image_data:
                    image_data = image_data.split(',')[1]
                payload = {
                    "mime_type": "image/jpeg",
                    "data": base64.b64decode(image_data)
                }
            else:
                return

            audio_loop._latest_image_payload = payload
        except Exception as e:
            print(f"[VISION ERR] Failed to parse vision frame: {e}")

@sio.event
async def confirm_tool(sid, data):
    # data: { "id": "...", "confirmed": True/False }
    request_id = data.get('id')
    confirmed = data.get('confirmed', False)
    
    print(f"[SERVER DEBUG] Received confirmation response for {request_id}: {confirmed}")
    
    if audio_loop:
        audio_loop.resolve_tool_confirmation(request_id, confirmed)
    else:
        print("Audio loop not active, cannot resolve confirmation.")

@sio.event
async def shutdown(sid, data=None):
    """Gracefully shutdown the server when the application closes."""
    global audio_loop, loop_task, authenticator
    
    print("[SERVER] ========================================")
    print("[SERVER] SHUTDOWN SIGNAL RECEIVED FROM FRONTEND")
    print("[SERVER] ========================================")
    
    # Stop audio loop
    if audio_loop:
        print("[SERVER] Stopping Audio Loop...")
        audio_loop.stop()
        audio_loop = None
    
    # Cancel the loop task if running
    if loop_task and not loop_task.done():
        print("[SERVER] Cancelling loop task...")
        loop_task.cancel()
        loop_task = None
    
    # Stop authenticator if running
    if authenticator:
        print("[SERVER] Stopping Authenticator...")
        authenticator.stop()
    
    print("[SERVER] Graceful shutdown complete. Terminating process...")
    
    # Force exit immediately - os._exit bypasses cleanup but ensures termination
    os._exit(0)

@sio.event
async def user_input(sid, data):
    text = data.get('text')
    print(f"[SERVER DEBUG] User input received: '{text}'")

    await _maybe_refresh_startup_checks(force=False)

    if STARTUP_CHECKS.get("ready") is False and _text_fallback_available():
        try:
            fallback_text = await ada.generate_text_reply(text)
            if audio_loop and audio_loop.project_manager:
                audio_loop.project_manager.log_chat("User", text)
                audio_loop.project_manager.log_chat("ADA", fallback_text)
            await sio.emit('status', {'msg': 'Text Fallback Mode'})
            await sio.emit('transcription', {'sender': 'ADA', 'text': fallback_text})
            tts_ok = await _deliver_tts_fallback_audio(fallback_text)
            if not tts_ok:
                await sio.emit('status', {'msg': 'Fallback Voice Unavailable'})
            return
        except Exception as exc:
            print(f"[SERVER] Direct text fallback failed: {exc}")

    session_ready = await ensure_audio_session({'muted': True})
    if not session_ready:
        print("[SERVER DEBUG] [Error] Session did not become ready. Cannot send text.")
        detailed_error = None
        if audio_loop:
            detailed_error = getattr(audio_loop, 'last_connection_error', None)

        try:
            fallback_text = await ada.generate_text_reply(text)
            await sio.emit('status', {'msg': 'Text Fallback Mode'})
        except Exception as exc:
            print(f"[SERVER] Text fallback failed: {exc}")
            fallback_text = _build_local_fallback_reply(text, detailed_error or str(exc) or "Unknown provider startup error")
            await sio.emit('status', {'msg': 'Fallback Mode'})

        if audio_loop and audio_loop.project_manager:
            audio_loop.project_manager.log_chat("ADA", fallback_text)
        await sio.emit('transcription', {'sender': 'ADA', 'text': fallback_text})
        tts_ok = await _deliver_tts_fallback_audio(fallback_text)
        if not tts_ok:
            await sio.emit('status', {'msg': 'Fallback Voice Unavailable'})
        if detailed_error and "unsupported" not in detailed_error.lower():
            await sio.emit('error', {
                'msg': detailed_error or 'ADA session failed to start. Check backend startup logs.'
            })
        return

    if text:
        print(f"[SERVER DEBUG] Sending message to model: '{text}'")
        
        # Log User Input to Project History
        if audio_loop and audio_loop.project_manager:
            audio_loop.project_manager.log_chat("User", text)
            
        # Use the same 'send' method that worked for audio, as 'send_realtime_input' and 'send_client_content' seem unstable in this env
        # INJECT VIDEO FRAME IF AVAILABLE (VAD-style logic for Text Input)
        if audio_loop and audio_loop._latest_image_payload:
            print(f"[SERVER DEBUG] Piggybacking video frame with text input.")
            try:
                # Send frame first
                await audio_loop.session.send(input=audio_loop._latest_image_payload, end_of_turn=False)
            except Exception as e:
                print(f"[SERVER DEBUG] Failed to send piggyback frame: {e}")
                
        await audio_loop.session.send(input=text, end_of_turn=True)
        print(f"[SERVER DEBUG] Message sent to model successfully.")

import json
from datetime import datetime
from pathlib import Path

# ... (imports)

@sio.event
async def video_frame(sid, data):
    # data should contain 'image' which is binary (blob) or base64 encoded
    image_data = data.get('image')
    if image_data and audio_loop:
        # We don't await this because we don't want to block the socket handler
        # But send_frame is async, so we create a task
        asyncio.create_task(audio_loop.send_frame(image_data))

@sio.event
async def save_memory(sid, data):
    try:
        messages = data.get('messages', [])
        if not messages:
            print("No messages to save.")
            return

        # Ensure directory exists
        memory_dir = Path("long_term_memory")
        memory_dir.mkdir(exist_ok=True)

        # Generate filename
        # Use provided filename if available, else timestamp
        provided_name = data.get('filename')
        
        if provided_name:
            # Simple sanitization
            if not provided_name.endswith('.txt'):
                provided_name += '.txt'
            # Prevent directory traversal
            filename = memory_dir / Path(provided_name).name 
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = memory_dir / f"memory_{timestamp}.txt"

        # Write to file
        with open(filename, 'w', encoding='utf-8') as f:
            for msg in messages:
                sender = msg.get('sender', 'Unknown')
                text = msg.get('text', '')
                f.write(f"[{sender}]: {text}\n")
        print(f"Conversation saved to {filename}")
        await sio.emit('status', {'msg': 'Memory Saved Successfully'})

    except Exception as e:
        print(f"Error saving memory: {e}")
        await sio.emit('error', {'msg': f"Failed to save memory: {str(e)}"})

@sio.event
async def upload_memory(sid, data):
    print(f"Received memory upload request")
    try:
        memory_text = data.get('memory', '')
        if not memory_text:
            print("No memory data provided.")
            return

        if not audio_loop:
             print("[SERVER DEBUG] [Error] Audio loop is None. Cannot load memory.")
             await sio.emit('error', {'msg': "System not ready (Audio Loop inactive)"})
             return
        
        if not audio_loop.session:
             print("[SERVER DEBUG] [Error] Session is None. Cannot load memory.")
             await sio.emit('error', {'msg': "System not ready (No active session)"})
             return

        # Send to model
        print("Sending memory context to model...")
        context_msg = f"System Notification: The user has uploaded a long-term memory file. Please load the following context into your understanding. The format is a text log of previous conversations:\n\n{memory_text}"
        
        await audio_loop.session.send(input=context_msg, end_of_turn=True)
        print("Memory context sent successfully.")
        await sio.emit('status', {'msg': 'Memory Loaded into Context'})

    except Exception as e:
        print(f"Error uploading memory: {e}")
        await sio.emit('error', {'msg': f"Failed to upload memory: {str(e)}"})

@sio.event
async def discover_kasa(sid):
    print(f"Received discover_kasa request")
    try:
        devices = await kasa_agent.discover_devices()
        await sio.emit('kasa_devices', devices)
        await sio.emit('status', {'msg': f"Found {len(devices)} Kasa devices"})
        
        # Save to settings
        # devices is a list of full device info dicts. minimizing for storage.
        saved_devices = []
        for d in devices:
            saved_devices.append({
                "ip": d["ip"],
                "alias": d["alias"],
                "model": d["model"]
            })
        
        # Merge with existing to preserve any manual overrides? 
        # For now, just overwrite with latest scan result + previously known if we want to be fancy,
        # but user asked for "Any new devices that are scanned are added there".
        # A simple full persistence of current state is safest.
        SETTINGS["kasa_devices"] = saved_devices
        save_settings()
        print(f"[SERVER] Saved {len(saved_devices)} Kasa devices to settings.")
        
    except Exception as e:
        print(f"Error discovering kasa: {e}")
        await sio.emit('error', {'msg': f"Kasa Discovery Failed: {str(e)}"})

@sio.event
async def iterate_cad(sid, data):
    # data: { prompt: "make it bigger" }
    prompt = data.get('prompt')
    print(f"Received iterate_cad request: '{prompt}'")
    
    if not audio_loop or not audio_loop.cad_agent:
        await sio.emit('error', {'msg': "CAD Agent not available"})
        return

    try:
        # Notify user work has started
        await sio.emit('status', {'msg': 'Iterating design...'})
        await sio.emit('cad_status', {'status': 'generating'})
        
        # Call the agent with project path
        cad_output_dir = str(audio_loop.project_manager.get_current_project_path() / "cad")
        result = await audio_loop.cad_agent.iterate_prototype(prompt, output_dir=cad_output_dir)
        
        if result:
            info = f"{len(result.get('data', ''))} bytes (STL)"
            print(f"Sending updated CAD data: {info}")
            await sio.emit('cad_data', result)
            # Save to Project
            if 'file_path' in result:
                saved_path = audio_loop.project_manager.save_cad_artifact(result['file_path'], prompt)
                if saved_path:
                    print(f"[SERVER] Saved iterated CAD to {saved_path}")

            await sio.emit('status', {'msg': 'Design updated'})
        else:
            await sio.emit('error', {'msg': 'Failed to update design'})
            
    except Exception as e:
        print(f"Error iterating CAD: {e}")
        await sio.emit('error', {'msg': f"Iteration Error: {str(e)}"})

@sio.event
async def generate_cad(sid, data):
    # data: { prompt: "make a cube" }
    prompt = data.get('prompt')
    print(f"Received generate_cad request: '{prompt}'")
    
    if not audio_loop or not audio_loop.cad_agent:
        await sio.emit('error', {'msg': "CAD Agent not available"})
        return

    try:
        await sio.emit('status', {'msg': 'Generating new design...'})
        await sio.emit('cad_status', {'status': 'generating'})
        
        # Use generate_prototype based on prompt with project path
        cad_output_dir = str(audio_loop.project_manager.get_current_project_path() / "cad")
        result = await audio_loop.cad_agent.generate_prototype(prompt, output_dir=cad_output_dir)
        
        if result:
            info = f"{len(result.get('data', ''))} bytes (STL)"
            print(f"Sending newly generated CAD data: {info}")
            await sio.emit('cad_data', result)


            # Save to Project
            if 'file_path' in result:
                saved_path = audio_loop.project_manager.save_cad_artifact(result['file_path'], prompt)
                if saved_path:
                    print(f"[SERVER] Saved generated CAD to {saved_path}")

            await sio.emit('status', {'msg': 'Design generated'})
        else:
            await sio.emit('error', {'msg': 'Failed to generate design'})
            
    except Exception as e:
        print(f"Error generating CAD: {e}")
        await sio.emit('error', {'msg': f"Generation Error: {str(e)}"})

@sio.event
async def prompt_web_agent(sid, data):
    # data: { prompt: "find xyz" }
    prompt = data.get('prompt')
    print(f"Received web agent prompt: '{prompt}'")
    
    if not audio_loop or not audio_loop.web_agent:
        await sio.emit('error', {'msg': "Web Agent not available"})
        return

    try:
        await sio.emit('status', {'msg': 'Web Agent running...'})
        
        # We assume web_agent has a run method or similar.
        # This might block the loop if not strictly async or offloaded.
        # Ideally web_agent.run is async.
        # And it should emit 'browser_snap' and logs automatically via hooks if setup.
        
        # We might need to launch this as a task if it's long running?
        # asyncio.create_task(audio_loop.web_agent.run(prompt))
        # But we want to catch errors here.
        
        # Based on typical agent design, run() is the entry point.
        await audio_loop.web_agent.run(prompt)
        
        await sio.emit('status', {'msg': 'Web Agent finished'})
        
    except Exception as e:
        print(f"Error running Web Agent: {e}")
        await sio.emit('error', {'msg': f"Web Agent Error: {str(e)}"})

@sio.event
async def create_anime_series_package(sid, data):
    concept = data.get('concept', '')
    protagonist_name = data.get('protagonist_name', '')
    episode_count = data.get('episode_count', 3)
    target_platforms = data.get('target_platforms', 'youtube,tiktok')

    if not audio_loop or not audio_loop.anime_series_agent:
        await sio.emit('error', {'msg': 'Anime Series Agent not available'})
        return

    try:
        await sio.emit('status', {'msg': 'Building anime series package...'})
        result = await audio_loop.anime_series_agent.create_series_package_payload(
            concept,
            protagonist_name=protagonist_name,
            episode_count=episode_count,
            target_platforms=target_platforms,
        )
        await sio.emit('anime_series_result', result)
        await sio.emit('status', {'msg': 'Anime series package ready'})
    except Exception as e:
        print(f"Error creating anime series package: {e}")
        await sio.emit('error', {'msg': f"Anime Series Error: {str(e)}"})

@sio.event
async def generate_video_from_shot(sid, data):
    prompt = data.get('prompt', '')
    platform = data.get('platform', 'veo')
    duration = data.get('duration', 1)
    episode = data.get('episode')
    shot = data.get('shot')

    if not audio_loop or not audio_loop.video_agent:
        await sio.emit('error', {'msg': 'Video Agent not available'})
        return

    if not prompt or not str(prompt).strip():
        await sio.emit('error', {'msg': 'Video prompt is required'})
        return

    try:
        shot_label = f"episode {episode}, shot {shot}" if episode and shot else 'selected shot'
        await sio.emit('status', {'msg': f'Generating Veo clip for {shot_label}...'})
        result = await audio_loop.video_agent.generate_long_form_video(prompt, platform, duration)
        await sio.emit('video_generation_result', {
            'success': 'generated successfully and saved to:' in result.lower(),
            'message': result,
            'prompt': prompt,
            'platform': platform,
            'episode': episode,
            'shot': shot,
        })
        await sio.emit('status', {'msg': 'Video generation request finished'})
    except Exception as e:
        print(f"Error generating video from shot: {e}")
        await sio.emit('error', {'msg': f"Video Generation Error: {str(e)}"})

@sio.event
async def discover_printers(sid):
    print("Received discover_printers request")
    
    # If audio_loop isn't ready yet, return saved printers from settings
    if not audio_loop or not audio_loop.printer_agent:
        saved_printers = SETTINGS.get("printers", [])
        if saved_printers:
            # Convert saved printers to the expected format
            printer_list = []
            for p in saved_printers:
                printer_list.append({
                    "name": p.get("name", p["host"]),
                    "host": p["host"],
                    "port": p.get("port", 80),
                    "printer_type": p.get("type", "unknown"),
                    "camera_url": p.get("camera_url")
                })
            print(f"[SERVER] Returning {len(printer_list)} saved printers (audio_loop not ready)")
            await sio.emit('printer_list', printer_list)
            return
        else:
            await sio.emit('printer_list', [])
            await sio.emit('status', {'msg': "Connect to A.D.A to enable printer discovery"})
            return
        
    try:
        printers = await audio_loop.printer_agent.discover_printers()
        await sio.emit('printer_list', printers)
        await sio.emit('status', {'msg': f"Found {len(printers)} printers"})
    except Exception as e:
        print(f"Error discovering printers: {e}")
        await sio.emit('error', {'msg': f"Printer Discovery Failed: {str(e)}"})

@sio.event
async def add_printer(sid, data):
    # data: { host: "192.168.1.50", name: "My Printer", type: "moonraker" }
    raw_host = data.get('host')
    name = data.get('name') or raw_host
    ptype = data.get('type', "moonraker")
    
    # Parse port if present
    if ":" in raw_host:
        host, port_str = raw_host.split(":")
        port = int(port_str)
    else:
        host = raw_host
        port = 80
    
    print(f"Received add_printer request: {host}:{port} ({ptype})")
    
    if not audio_loop or not audio_loop.printer_agent:
        await sio.emit('error', {'msg': "Printer Agent not available"})
        return
        
    try:
        # Add manually
        camera_url = data.get('camera_url')
        printer = audio_loop.printer_agent.add_printer_manually(name, host, port=port, printer_type=ptype, camera_url=camera_url)
        
        # Save to settings
        new_printer_config = {
            "name": name,
            "host": host,
            "port": port,
            "type": ptype,
            "camera_url": camera_url
        }
        
        # Check if already exists to avoid duplicates
        exists = False
        for p in SETTINGS.get("printers", []):
            if p["host"] == host and p["port"] == port:
                exists = True
                break
        
        if not exists:
            if "printers" not in SETTINGS:
                SETTINGS["printers"] = []
            SETTINGS["printers"].append(new_printer_config)
            save_settings()
            print(f"[SERVER] Saved printer {name} to settings.")
        
        # Probe to confirm/correct type
        print(f"Probing {host} to confirm type...")
        # Try port 7125 (Moonraker) and 4408 (Fluidd/K1) 
        ports_to_try = [80, 7125, 4408]
        
        actual_type = "unknown"
        for port in ports_to_try:
             found_type = await audio_loop.printer_agent._probe_printer_type(host, port)
             if found_type.value != "unknown":
                 actual_type = found_type
                 # Update port if different
                 if port != 80:
                     printer.port = port
                 break
        
        if actual_type != "unknown" and actual_type != printer.printer_type:
             printer.printer_type = actual_type
             print(f"Corrected type to {actual_type.value} on port {printer.port}")
             
        # Refresh list for everyone
        printers = [p.to_dict() for p in audio_loop.printer_agent.printers.values()]
        await sio.emit('printer_list', printers)
        await sio.emit('status', {'msg': f"Added printer: {name}"})
        
    except Exception as e:
        print(f"Error adding printer: {e}")
        await sio.emit('error', {'msg': f"Failed to add printer: {str(e)}"})

@sio.event
async def print_stl(sid, data):
    print(f"Received print_stl request: {data}")
    # data: { stl_path: "path/to.stl" | "current", printer: "name_or_ip", profile: "optional" }
    
    if not audio_loop or not audio_loop.printer_agent:
        await sio.emit('error', {'msg': "Printer Agent not available"})
        return
        
    try:
        stl_path = data.get('stl_path', 'current')
        printer_name = data.get('printer')
        profile = data.get('profile')
        
        if not printer_name:
             await sio.emit('error', {'msg': "No printer specified"})
             return
             
        await sio.emit('status', {'msg': f"Preparing print for {printer_name}..."})
        
        # Get current project path for resolution
        current_project_path = None
        if audio_loop and audio_loop.project_manager:
            current_project_path = str(audio_loop.project_manager.get_current_project_path())
            print(f"[SERVER DEBUG] Using project path: {current_project_path}")

        # Resolve STL path before slicing so we can preview it
        resolved_stl = audio_loop.printer_agent._resolve_file_path(stl_path, current_project_path)
        
        if resolved_stl and os.path.exists(resolved_stl):
            # Open the STL in the CAD module for preview
            try:
                import base64
                with open(resolved_stl, 'rb') as f:
                    stl_data = f.read()
                stl_b64 = base64.b64encode(stl_data).decode('utf-8')
                stl_filename = os.path.basename(resolved_stl)
                
                print(f"[SERVER] Opening STL in CAD module: {stl_filename}")
                await sio.emit('cad_data', {
                    'format': 'stl',
                    'data': stl_b64,
                    'filename': stl_filename
                })
            except Exception as e:
                print(f"[SERVER] Warning: Could not preview STL: {e}")
        
        # Progress Callback
        async def on_slicing_progress(percent, message):
            await sio.emit('slicing_progress', {
                'printer': printer_name,
                'percent': percent,
                'message': message
            })
            if percent < 100:
                 await sio.emit('status', {'msg': f"Slicing: {percent}%"})

        result = await audio_loop.printer_agent.print_stl(
            stl_path, 
            printer_name, 
            profile,
            progress_callback=on_slicing_progress,
            root_path=current_project_path
        )
        
        await sio.emit('print_result', result)
        await sio.emit('status', {'msg': f"Print Job: {result.get('status', 'unknown')}"})
        
    except Exception as e:
        print(f"Error printing STL: {e}")
        await sio.emit('error', {'msg': f"Print Failed: {str(e)}"})

@sio.event
async def get_slicer_profiles(sid):
    """Get available OrcaSlicer profiles for manual selection."""
    print("Received get_slicer_profiles request")
    if not audio_loop or not audio_loop.printer_agent:
        await sio.emit('error', {'msg': "Printer Agent not available"})
        return
    
    try:
        profiles = audio_loop.printer_agent.get_available_profiles()
        await sio.emit('slicer_profiles', profiles)
    except Exception as e:
        print(f"Error getting slicer profiles: {e}")
        await sio.emit('error', {'msg': f"Failed to get profiles: {str(e)}"})

@sio.event
async def control_kasa(sid, data):
    # data: { ip, action: "on"|"off"|"brightness"|"color", value: ... }
    ip = data.get('ip')
    action = data.get('action')
    print(f"Kasa Control: {ip} -> {action}")
    
    try:
        success = False
        if action == "on":
            success = await kasa_agent.turn_on(ip)
        elif action == "off":
            success = await kasa_agent.turn_off(ip)
        elif action == "brightness":
            val = data.get('value')
            success = await kasa_agent.set_brightness(ip, val)
        elif action == "color":
            # value is {h, s, v} - convert to tuple for set_color
            h = data.get('value', {}).get('h', 0)
            s = data.get('value', {}).get('s', 100)
            v = data.get('value', {}).get('v', 100)
            success = await kasa_agent.set_color(ip, (h, s, v))
        
        if success:
            await sio.emit('kasa_update', {
                'ip': ip,
                'is_on': True if action == "on" else (False if action == "off" else None),
                'brightness': data.get('value') if action == "brightness" else None,
            })
 
        else:
             await sio.emit('error', {'msg': f"Failed to control device {ip}"})

    except Exception as e:
         print(f"Error controlling kasa: {e}")
         await sio.emit('error', {'msg': f"Kasa Control Error: {str(e)}"})

@sio.event
async def get_settings(sid):
    await sio.emit('settings', SETTINGS)

@sio.event
async def get_connections(sid):
    status = await asyncio.to_thread(manager().public_status)
    await sio.emit('connections', status, room=sid)

@sio.event
async def oauth_save_credentials(sid, data):
    payload = data or {}
    provider = payload.get("provider", "")
    try:
        await asyncio.to_thread(
            manager().save_app_credentials,
            provider,
            payload.get("client_id"),
            payload.get("client_secret"),
        )
    except OAuthError as exc:
        await sio.emit('oauth_message', {'provider': provider, 'ok': False, 'message': str(exc)}, room=sid)
        return
    await sio.emit('connections', manager().public_status(), room=sid)
    await sio.emit('oauth_message', {'provider': provider, 'ok': True, 'message': 'Saved on this PC.'}, room=sid)

@sio.event
async def oauth_connect(sid, data):
    payload = data or {}
    provider = payload.get("provider", "")
    if "client_id" in payload or "client_secret" in payload:
        try:
            await asyncio.to_thread(
                manager().save_app_credentials,
                provider,
                payload.get("client_id") if "client_id" in payload else None,
                payload.get("client_secret") if "client_secret" in payload else None,
            )
        except OAuthError as exc:
            await sio.emit('oauth_message', {'provider': provider, 'ok': False, 'message': str(exc)}, room=sid)
            return
    try:
        started = await asyncio.to_thread(manager().begin, provider)
    except OAuthError as exc:
        await sio.emit('connections', manager().public_status(), room=sid)
        await sio.emit('oauth_message', {'provider': provider, 'ok': False, 'message': str(exc)}, room=sid)
        return
    opened = False
    try:
        opened = bool(webbrowser.open(started["url"], new=2))
    except Exception:
        opened = False
    print(f"[OAUTH] {provider} login {'opened in the browser' if opened else 'is ready in Settings'}.")
    message = "Login page opened in your browser." if opened else "ADA could not open the browser. Use Open login page."
    await sio.emit('oauth_message', {
        'provider': provider,
        'ok': True,
        'opened': opened,
        'message': message,
        'url': started["url"],
    }, room=sid)

@sio.event
async def oauth_disconnect(sid, data):
    service = (data or {}).get("service", "")
    try:
        await asyncio.to_thread(manager().disconnect, service)
    except OAuthError as exc:
        await sio.emit('oauth_message', {'provider': service, 'ok': False, 'message': str(exc)}, room=sid)
        return
    await sio.emit('connections', manager().public_status())

@sio.event
async def update_settings(sid, data):
    # Generic update
    print(f"Updating settings: {data}")
    
    # Handle specific keys if needed
    if "tool_permissions" in data:
        SETTINGS["tool_permissions"].update(data["tool_permissions"])
        if audio_loop:
            audio_loop.update_permissions(SETTINGS["tool_permissions"])
            
    if "face_auth_enabled" in data:
        SETTINGS["face_auth_enabled"] = data["face_auth_enabled"]
        # If turned OFF, maybe emit auth status true?
        if not data["face_auth_enabled"]:
             await sio.emit('auth_status', {'authenticated': True})
             # Stop auth loop if running?
             if authenticator:
                 authenticator.stop() 

    if "camera_flipped" in data:
        SETTINGS["camera_flipped"] = data["camera_flipped"]
        print(f"[SERVER] Camera flip set to: {data['camera_flipped']}")

    if data.get("ada_personality") == "__reset__":
        SETTINGS["ada_personality"] = ada.DEFAULT_PERSONALITY
    elif "ada_personality" in data:
        SETTINGS["ada_personality"] = str(data.get("ada_personality") or "")

    if "voice_name" in data and data["voice_name"] in mobile_behavior.VOICES:
        SETTINGS["voice_name"] = data["voice_name"]
    if "live_model" in data:
        SETTINGS["live_model"] = mobile_behavior.migrate_live_model(data.get("live_model"))
    if "text_model" in data:
        SETTINGS["text_model"] = mobile_behavior.migrate_text_model(data.get("text_model"))
    if "google_search" in data:
        SETTINGS["google_search"] = bool(data.get("google_search"))
    if "assistant_look" in data:
        SETTINGS["assistant_look"] = mobile_behavior.normalize_assistant_look(data.get("assistant_look"))

    save_settings()
    # Broadcast new full settings
    await sio.emit('settings', SETTINGS)


# Deprecated/Mapped for compatibility if frontend still uses specific events
@sio.event
async def get_tool_permissions(sid):
    await sio.emit('tool_permissions', SETTINGS["tool_permissions"])

@sio.event
async def update_tool_permissions(sid, data):
    print(f"Updating permissions (legacy event): {data}")
    SETTINGS["tool_permissions"].update(data)
    save_settings()
    
    if audio_loop:
        audio_loop.update_permissions(SETTINGS["tool_permissions"])
    # Broadcast update to all
    await sio.emit('tool_permissions', SETTINGS["tool_permissions"])


@sio.event
async def interrupt_audio(sid):
    if audio_loop:
        audio_loop.interrupt_speech()
        await sio.emit('status', {'msg': 'Interrupted'})


@sio.event
async def get_gemini_keys(sid):
    await sio.emit('gemini_keys', gemini_keys.public_view())


@sio.event
async def add_gemini_key(sid, data):
    message = gemini_keys.add((data or {}).get("key"))
    view = gemini_keys.public_view()
    if message:
        view = {**view, "error": message}
    else:
        _apply_active_gemini_key()
    await sio.emit('gemini_keys', view)


@sio.event
async def delete_gemini_key(sid, data):
    gemini_keys.delete_slot((data or {}).get("slot"))
    _apply_active_gemini_key()
    await sio.emit('gemini_keys', gemini_keys.public_view())


@sio.event
async def get_memories(sid):
    await sio.emit('memories', memory_book.list_notes())


@sio.event
async def delete_memory_note(sid, data):
    memory_book.delete(note_id=(data or {}).get("id"), title=(data or {}).get("title"))
    await sio.emit('memories', memory_book.list_notes())


@sio.event
async def sweety_say(sid, data):
    text = ((data or {}).get("text") or "").strip()
    if not text:
        await sio.emit('sweety_line', {'role': 'Sweety', 'text': 'Say something to Sweety first.'})
        return
    reply = await asyncio.to_thread(_sweety_text, text)
    make = '[[MAKE_IT]]' in reply
    clean = reply.replace('[[MAKE_IT]]', '').strip()
    await sio.emit('sweety_line', {'role': 'Sweety', 'text': clean, 'make': make})
    if (data or {}).get('make') or make:
        form = form_from_request(text)
        form['max_scenes'] = min(5, mobile_behavior.scene_count_for_minutes(form['minutes']))
        if form['minutes'] == 1 and 'minute' not in text.lower():
            form['max_scenes'] = 3
        result = film_job.start_form(form)
        await sio.emit('film_status', film_job.snapshot())
        await sio.emit('transcription', {'sender': 'System', 'text': result.get('line') or result.get('message') or clean})


@sio.event
async def write_script(sid, data):
    payload = data or {}
    script = mobile_behavior.draft_script(
        payload.get('topic'),
        payload.get('niche') or 'tech',
        payload.get('tone') or 'witty',
        payload.get('style') or 'cinematic',
        payload.get('length') or 60,
    )
    await sio.emit('script_draft', {'text': script})


@sio.event
async def render_scene(sid, data):
    prompt = ((data or {}).get('prompt') or '').strip()
    if len(prompt) < 12:
        await sio.emit('scene_status', {'error': 'Describe the scene in a sentence, Sir.'})
        return
    aspect = (data or {}).get('aspect') or '9:16'
    form = {
        'niche': 'Storytelling',
        'style': 'Cinematic',
        'aspect': aspect,
        'narrator': 'Storyteller',
        'minutes': 1,
        'topic': prompt,
        'max_scenes': 1,
        'crossfade': False,
        'captions': False,
        'voiceover': False,
    }
    result = film_job.start_form(form)
    await sio.emit('scene_status', {'line': result.get('line') or result.get('message'), 'ok': result.get('ok', False)})
    await sio.emit('film_status', film_job.snapshot())


@sio.event
async def start_film(sid, data):
    payload = data or {}
    form = {
        'niche': payload.get('niche') or 'Storytelling',
        'custom_niche': (payload.get('customNiche') or '')[:40],
        'narrator': payload.get('narrator') or 'Storyteller',
        'style': payload.get('style') or 'Cinematic',
        'aspect': payload.get('aspect') or '9:16 Shorts',
        'minutes': payload.get('minutes') or 1,
        'topic': (payload.get('topic') or '')[:500],
        'crossfade': payload.get('crossfade', True),
        'captions': payload.get('captions', True),
        'voiceover': payload.get('voiceover', True),
        'keep_clip_audio': payload.get('keepClipAudio', False),
    }
    result = film_job.start_form(form)
    line = result.get('line') or result.get('message')
    await sio.emit('transcription', {'sender': 'System', 'text': line})
    await sio.emit('film_status', film_job.snapshot())


@sio.event
async def cancel_film(sid):
    await sio.emit('film_status', film_job.cancel())


@sio.event
async def get_films(sid):
    await sio.emit('film_status', film_job.snapshot())


@sio.event
async def delete_film(sid, data):
    film_library.delete((data or {}).get('id'))
    await sio.emit('film_status', film_job.snapshot())


if __name__ == "__main__":
    # Desktop Electron expects 127.0.0.1:8000. LAN mode sets ADA_HOST=0.0.0.0.
    bind_host = os.environ.get("ADA_HOST", "127.0.0.1") or "127.0.0.1"
    bind_port = int(os.environ.get("ADA_PORT", "8000") or "8000")
    uvicorn.run(
        "server:app_socketio", 
        host=bind_host, 
        port=bind_port, 
        reload=False, # Reload enabled causes spawn of worker which might miss the event loop policy patch
        loop="asyncio",
        reload_excludes=["temp_cad_gen.py", "output.stl", "*.stl"]
    )
