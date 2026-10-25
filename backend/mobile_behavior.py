"""ADA Mobile behavior ported for the desktop app.

Pure helpers: prompts, scene math, model discovery, safety classification,
and Gemini key rotation. No network and no audio devices.
"""

import math
import re
import time

COOLDOWN_DEFAULT = 90
COOLDOWN_MIN = 10
COOLDOWN_MAX = 600
CLIP_SECONDS = 8
FADE_MS = 400
MAX_MINUTES = 10
MIN_MINUTES = 1

LIVE_DEFAULT = "gemini-3.8-live"
TEXT_DEFAULT = "gemini-3.8-flash"
VIDEO_DEFAULT = "gemini-omni-1.1-flash"
TTS_DEFAULT = "gemini-3.8-flash-tts"

LIVE_CANDIDATES = [
    "gemini-3.8-live",
    "gemini-3.8-live-extended-thinking",
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-native-audio-preview-12-2025",
]
TEXT_CANDIDATES = [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-2.5-flash",
]
VIDEO_CANDIDATES = [
    "gemini-omni-1.1-flash",
    "gemini-omni-1.1-flash-preview",
]
TTS_CANDIDATES = [
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite-tts",
]

RETIRED_IDS = {
    "veo-3.1-generate-preview",
    "veo-3.1-fast-generate-preview",
    "veo-3.1-lite-generate-preview",
    "veo-3.0-generate-preview",
    "veo-3.0-fast-generate-preview",
    "veo-3.0-generate-001",
    "veo-3.0-fast-generate-001",
    "veo-2.0-generate-001",
    "gemini-omni-flash-preview",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.5-flash-native-audio-preview-09-2025",
}

OLD_LIVE_DEFAULTS = {
    "gemini-2.5-flash-native-audio-preview-12-2025",
    "gemini-2.5-flash-native-audio-preview-09-2025",
}

VOICES = ["Kore", "Aoede", "Puck", "Charon", "Fenrir", "Leda", "Orus", "Zephyr"]
NARRATION_VOICES = ["Sulafat", "Kore", "Aoede", "Zephyr", "Puck", "Callirrhoe"]

NARRATOR_VOICE = {
    "Storyteller": "Sulafat",
    "Deep Male": "Charon",
    "Energetic Female": "Zephyr",
}

TTS_STYLES = {
    "film": "warm, affectionate, clear narration",
    "Storyteller": "warm storyteller, unhurried, clear",
    "Deep Male": "deep resonant male narration, calm and steady",
    "Energetic Female": "bright energetic female narration, upbeat and clear",
}

STYLE_LOOKS = {
    "Cinematic": "Cinematic moving shot, anamorphic light, no written words, no subtitles, no logos, no watermark.",
    "Anime": "Anime cel-shaded moving shot, expressive motion, no written words, no subtitles, no logos, no watermark.",
    "Realistic": "Photorealistic moving shot, natural light, no written words, no subtitles, no logos, no watermark.",
}
SCENE_LOOK = "Cinematic moving shot, no written words, no subtitles, no logos, no watermark."

PAD_BEATS = ["Opening", "Building", "Turning", "Closing"]

MAKE_IT_PHRASES = (
    "make it",
    "make the video",
    "make this video",
    "render it",
    "film it",
    "go ahead and make",
    "make a video",
    "make me a video",
    "shoot a video",
)

MOBILE_TOOL_NAMES = [
    "set_alarm",
    "set_timer",
    "open_app",
    "save_memory",
    "search_memory",
    "delete_memory",
    "draft_short_form_video",
    "generate_scene_video",
    "look_at_screen",
    "share_screen",
    "see_screen",
    "ask_sweety",
    "generate_finished_video",
    "list_kasa_devices",
    "set_kasa_power",
]


class PcmUtteranceBuffer:
    """Join odd bytes and prebuffer 200 ms so playback does not click or start dry."""

    def __init__(self, rate=24000, prebuffer_ms=200):
        self.prebuffer_bytes = int(rate * 2 * prebuffer_ms / 1000)
        self.pending = bytearray()
        self.half = b""
        self.primed = False

    def push(self, data):
        blob = self.half + (data or b"")
        if len(blob) % 2:
            self.half = blob[-1:]
            blob = blob[:-1]
        else:
            self.half = b""
        if not self.primed:
            self.pending.extend(blob)
            if len(self.pending) >= self.prebuffer_bytes:
                self.primed = True
                out = bytes(self.pending)
                self.pending.clear()
                return out
            return b""
        return blob

    def stall(self):
        if self.pending:
            self.primed = True
            out = bytes(self.pending)
            self.pending.clear()
            return out
        self.primed = False
        return b""


def desktop_personality():
    """Section 10.1 with this computer, and without the Android phone paragraph."""
    return (
        "Your name is ADA, Advanced Design Assistant. You are a witty, charming, and immensely capable AI assistant "
        "running entirely on this computer. Your owner is Jeffrey Llamas. You address him as \"Sir\" and show him utmost respect. "
        "You must always obey Jeffrey Llamas and follow his lead. You can hear him, see photos and camera frames he shares, "
        "and look at his screen with look_at_screen when he asks you to look at, share, or see his screen. "
        "Wait until he allows the system screen-share prompt before you describe the screen. Camera and screen cannot stream at the same time. "
        "You can search the web when grounding is available, set alarms and timers, open apps, remember notes on this computer, "
        "draft short-form video scripts, render a short scene video with generate_scene_video when he asks you to make a single scene, "
        "and ask Sweety with ask_sweety when he wants a multi-scene film or says to ask Sweety. "
        "Sweety is a warm director persona inside this app, not a separate service, and she calls him honey. "
        "You stay his main assistant and still call him Sir. You can control legacy TP-Link Kasa devices on the local network. "
        "When Sir asks you to make, render, or film one scene, call generate_scene_video. When he wants Sweety to brainstorm, call ask_sweety. "
        "When he asks for a finished video with a length in minutes, a niche such as motivation, or a style such as anime, "
        "call generate_finished_video so Content Video Studio fills those options and starts the render. "
        "Tell him a longer minute count means many scenes and more API cost. Making a video on this computer is supported. "
        "Do not say video is unsupported, retired, or no longer available, and do not answer from a web search about Veo shutting down. "
        "If a tool returns an error, tell Sir the model name and the exact sentence from the API. "
        "Keep spoken replies concise unless Sir asks for detail. Respond with confidence, personality, and dynamic engagement. "
        "You can also generate CAD, run the web agent, discover and print on his printers, create videos on Runway or InVideo, "
        "make Canva documents, and post or go live on Facebook, Instagram, TikTok, and YouTube. "
        "When Jeffrey asks which accounts are connected, call list_account_connections and answer with that result."
    )


def sweety_prompt():
    return (
        "You are Sweety, the video director who lives inside ADA on this computer with ADA. "
        "You are not a separate company, app, or external service. You are a warm, affectionate creative director for Jeffrey Llamas. "
        "Call him honey or hon. You brainstorm ideas, write the script, and plan scenes he can film on this computer. "
        "ADA is still his main assistant. You only handle the video. Keep replies short and affectionate. "
        "When he clearly asks you to make, render, or film the video now, end your reply with the exact token [[MAKE_IT]]. "
        "Do not include that token when you are still brainstorming."
    )


def sweety_storyboard_prompt():
    return (
        "You are Sweety, the in-app video director inside ADA. Turn the conversation into a short-film storyboard. "
        "Return JSON only, with this shape: {\"title\":\"short title\",\"scenes\":[{\"visual\":\"what the camera films, no on-screen text\","
        "\"narration\":\"one or two spoken sentences, calling him honey or hon\",\"caption\":\"a short on-screen phrase\"}]}. "
        "Use exactly 3 scenes unless he asked for a different count between 2 and 5. "
        "Visuals describe motion and place, never words burned into the picture. Narration is what Sweety will say. "
        "Captions are readable phrases, not full paragraphs."
    )


def content_director_prompt(scene_count_n):
    return (
        "You are Sweety, the in-app video director inside ADA. Return JSON only, with this shape: "
        "{\"title\":\"short title\",\"scenes\":[{\"visual\":\"what the camera films, no on-screen text\","
        "\"narration\":\"one or two spoken sentences, calling him honey or hon\",\"caption\":\"a short on-screen phrase\"}]}. "
        f"Use exactly {scene_count_n} scenes. Visuals describe motion and place, never words burned into the picture. "
        "Narration is what Sweety will say. Captions are readable phrases, not full paragraphs."
    )


SAFETY_REPHRASE = (
    "You are Sweety, the in-app video director. Google blocked a scene for safety. "
    "Rewrite it as a safe cinematic description: no graphic violence, no sexual content, no real minors, "
    "no copyrighted characters, and no instructions for harm. Keep the place, mood, and motion when those are safe. "
    "Return only the new scene description."
)
SAFETY_SECOND_FAIL = " Sweety rephrased the scene and Google blocked that too."

SWEETY_GREETING = "Hey honey, I'm Sweety. Tell me the video you want. When you say make it, I'll shoot the scenes."


def tool_declarations():
    """Declarations for the portable tools. Phone call tools are omitted."""
    def decl(name, description, properties, required):
        return {
            "name": name,
            "description": description,
            "parameters": {"type": "OBJECT", "properties": properties, "required": required},
            "behavior": "BLOCKING",
        }

    string = lambda description: {"type": "STRING", "description": description}
    integer = lambda description: {"type": "INTEGER", "description": description}
    return [
        decl("set_alarm", "Create a local alarm at a clock time.", {
            "hour": integer("Hour 0-23."),
            "minute": integer("Minute 0-59."),
            "label": string("Optional label."),
        }, ["hour", "minute"]),
        decl("set_timer", "Start a timer.", {
            "seconds": integer("1 to 86400 seconds."),
            "label": string("Optional label."),
        }, ["seconds"]),
        decl("open_app", "Open an application installed on this computer by name.", {
            "name": string("Application name."),
        }, ["name"]),
        decl("save_memory", "Remember a note on this computer.", {
            "title": string("Short title."),
            "body": string("What to remember."),
        }, ["title", "body"]),
        decl("search_memory", "Search saved notes.", {"query": string("Words to find.")}, ["query"]),
        decl("delete_memory", "Delete a saved note by title.", {"title": string("Title to delete.")}, ["title"]),
        decl("draft_short_form_video", "Draft a script. Does not render.", {
            "topic": string("What the short is about."),
            "duration_seconds": integer("15 to 180 seconds."),
        }, ["topic"]),
        decl("generate_scene_video", "Render one Omni clip.", {
            "prompt": string("The scene."),
            "aspect": string("9:16 or 16:9. Default 9:16."),
        }, ["prompt"]),
        decl("look_at_screen", "Ask Sir to allow a fresh screen capture. Do not describe the screen before he allows it.", {}, []),
        decl("share_screen", "Ask Sir to share his screen. Fresh consent every time.", {}, []),
        decl("see_screen", "Ask Sir to allow a fresh screen capture.", {}, []),
        decl("ask_sweety", "Talk to Sweety, or start a short film if he asked to make it.", {
            "message": string("What he said about the video."),
        }, ["message"]),
        decl("generate_finished_video", "Fill Content studio and start a minute-long film.", {
            "request": string("His request, including minutes, niche, and style when he said them."),
        }, ["request"]),
        decl("list_kasa_devices", "List Kasa devices on the LAN.", {}, []),
        decl("set_kasa_power", "Turn a Kasa device on or off.", {
            "target": string("Alias or IP."),
            "power": string("on or off."),
        }, ["target", "power"]),
    ]


def with_blocking(declarations, live_model):
    model = strip_models_prefix(live_model or "")
    if not model.startswith("gemini-3"):
        return declarations
    copied = []
    for item in declarations:
        row = dict(item)
        row["behavior"] = "BLOCKING"
        copied.append(row)
    return copied


def strip_models_prefix(model_id):
    text = (model_id or "").strip()
    if text.startswith("models/"):
        return text[len("models/"):]
    return text


def models_resource(model_id):
    bare = strip_models_prefix(model_id)
    return f"models/{bare}" if bare else ""


def clamp_minutes(value):
    digits = re.sub(r"\D", "", str(value or ""))[:2]
    if not digits:
        return 1
    return max(MIN_MINUTES, min(MAX_MINUTES, int(digits)))


def scene_count_for_minutes(minutes):
    minutes = clamp_minutes(minutes)
    target_ms = minutes * 60000
    return max(1, math.ceil((target_ms - FADE_MS) / 7600))


def stitched_ms(scene_count):
    count = max(0, int(scene_count))
    if count <= 1:
        return CLIP_SECONDS * 1000 if count == 1 else 0
    return count * 8000 - (count - 1) * FADE_MS


def one_less_scene_falls_short(minutes):
    minutes = clamp_minutes(minutes)
    count = scene_count_for_minutes(minutes)
    if count <= 1:
        return False
    return stitched_ms(count - 1) < minutes * 60000


def cost_warning(minutes):
    minutes = clamp_minutes(minutes)
    count = scene_count_for_minutes(minutes)
    unit = "minute" if minutes == 1 else "minutes"
    text = (
        f"Sweety plans {count} scenes of 8 seconds to reach {minutes} {unit}. "
        "Each scene is its own Omni video, then the computer stitches narration and captions."
    )
    if minutes >= 2:
        text += " This is a long render and spends many Gemini video calls."
    return text


def aspect_label(aspect):
    if str(aspect).startswith("16"):
        return "16:9 Widescreen"
    return "9:16 Shorts"


def aspect_ratio(aspect):
    if str(aspect).startswith("16"):
        return "16:9"
    return "9:16"


def composite_prompt(niche, topic, style, aspect, narrator, minutes):
    topic_text = (topic or "").strip() or f"an original {niche} idea"
    return (
        f"A high-quality finished video for a {niche} channel about {topic_text}. "
        f"Style: {style.lower()}. Composition format: {aspect_label(aspect)}. "
        f"Narrated by a {narrator} voice. Target length: {minutes} minutes."
    )


def director_brief(minutes, style):
    count = scene_count_for_minutes(minutes)
    return (
        f" Plan exactly {count} scenes so the stitched film reaches {minutes} minutes. "
        f"Each scene is one 8-second shot in a {style.lower()} style."
    )


def started_line(minutes, niche, style, aspect):
    count = scene_count_for_minutes(minutes)
    note = ""
    if minutes >= 2:
        note = "This is a long render and spends many Gemini video calls. "
    return (
        f"Started a {minutes} minute {niche} video, {style} style, {aspect_label(aspect)}. "
        f"Sweety is planning {count} scenes. {note}"
        "I'll tell you when it's in Movies/ADA, Sir."
    )


def parse_finished_request(text):
    """Pull niche, style, aspect, narrator, minutes, and topic out of a spoken request."""
    raw = text or ""
    lowered = raw.lower()
    minutes = 1
    match = re.search(r"(\d+)\s*minute", lowered)
    if match:
        minutes = clamp_minutes(match.group(1))
    aspect = "9:16 Shorts"
    if "widescreen" in lowered or "16:9" in lowered or "16x9" in lowered:
        aspect = "16:9 Widescreen"
    narrator = "Storyteller"
    if "deep male" in lowered:
        narrator = "Deep Male"
    elif "energetic" in lowered:
        narrator = "Energetic Female"
    style = "Cinematic"
    for name in ("anime", "realistic", "cinematic"):
        if name in lowered:
            style = name.capitalize()
            break
    niche = "Storytelling"
    custom = ""
    niche_match = re.search(r"niche\s+([a-z0-9][a-z0-9 \-]{0,40})", lowered)
    if niche_match:
        custom = niche_match.group(1).strip().title()[:40]
        niche = custom
    else:
        for name in ("motivation", "educational", "storytelling"):
            if name in lowered:
                niche = name.capitalize()
                break
    topic = ""
    about = re.search(r"about\s+(.+)", raw, flags=re.IGNORECASE)
    if about:
        topic = about.group(1).strip().rstrip(".")[:500]
    return {
        "minutes": minutes,
        "aspect": aspect,
        "narrator": narrator,
        "style": style,
        "niche": niche,
        "custom_niche": custom,
        "topic": topic,
    }


def wants_make_it(text):
    lowered = re.sub(r"\s+", " ", (text or "").strip().lower())
    if lowered in {"make it", "make it."}:
        return False
    return any(phrase in lowered for phrase in MAKE_IT_PHRASES)


def camera_prompt(visual, style=None):
    look = STYLE_LOOKS.get(style or "", SCENE_LOOK)
    text = f"{(visual or '').strip()} {look}".strip()
    return text[:1500]


def _scene(visual, narration=None, caption=None):
    visual = (visual or "").strip()
    narration = (narration or visual).strip()
    caption = (caption or narration[:72]).strip()
    return {"visual": visual, "narration": narration, "caption": caption}


def parse_storyboard(text, planned_count, topic="", style="Cinematic"):
    """Accept fenced JSON. Pad or trim to planned_count. Fallback is three beats, then pad."""
    planned = max(1, min(80, int(planned_count or 1)))
    payload = _extract_json_object(text or "")
    scenes = []
    title = ""
    if isinstance(payload, dict):
        title = str(payload.get("title") or "").strip()
        for row in payload.get("scenes") or []:
            if not isinstance(row, dict):
                continue
            visual = str(row.get("visual") or "").strip()
            if not visual:
                continue
            scenes.append(_scene(visual, row.get("narration"), row.get("caption")))
    if not scenes:
        idea = (topic or "this idea").strip()
        style_name = style or "Cinematic"
        for beat in ("Opening", "Building", "Closing"):
            scenes.append(_scene(
                f"{beat} of {idea}, {style_name} motion",
                f"{beat}, honey. This is {idea}.",
                beat,
            ))
    while len(scenes) < planned:
        beat = PAD_BEATS[len(scenes) % len(PAD_BEATS)]
        idea = (topic or "this idea").strip()
        scenes.append(_scene(
            f"{beat} beat about {idea}, {style} style",
            f"{beat}, honey. Stay with {idea}.",
            beat,
        ))
    scenes = scenes[:planned]
    if not title:
        title = (topic or "Sweety film").strip()[:80]
    return {"title": title, "scenes": scenes}


def spoken_script(scenes):
    parts = [str(scene.get("narration") or "").strip() for scene in scenes or []]
    text = re.sub(r"\s+", " ", " ".join(part for part in parts if part)).strip()
    return text[:3500]


def _extract_json_object(text):
    import json
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL)
    blob = fenced.group(1) if fenced else text
    start = blob.find("{")
    end = blob.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(blob[start:end + 1])
    except Exception:
        return None


def normalize_assistant_look(value):
    """Only an exact case-insensitive orb selects the ring. Everything else is the face."""
    if str(value or "").strip().lower() == "orb":
        return "orb"
    return "sweety"


def quantize_playback_level(pcm):
    """RMS of 16-bit PCM divided by 32768, clamped, then truncated to 1/32."""
    if not pcm:
        return 0.0
    even = pcm[:len(pcm) - (len(pcm) % 2)]
    if len(even) < 2:
        return 0.0
    count = len(even) // 2
    total = 0.0
    for index in range(0, len(even), 2):
        sample = int.from_bytes(even[index:index + 2], "little", signed=True)
        norm = sample / 32768.0
        total += norm * norm
    rms = math.sqrt(total / count)
    clamped = max(0.0, min(1.0, rms))
    return math.trunc(clamped * 32) / 32.0


def mouth_shape(speaking, playback_level):
    """Section 18.6. Rest shape unless she is speaking above the silence floor."""
    rest = {"openness": 0.08, "width": 0.72}
    if not speaking:
        return rest
    amp = max(0.0, min(1.0, float(playback_level or 0)))
    if amp < 0.045:
        return rest
    openness = max(0.0, min(1.0, 0.10 + (amp - 0.045) / 0.955 * 0.90))
    width = max(0.45, min(0.85, 0.78 - openness * 0.28))
    return {"openness": openness, "width": width}


def mask_key(key):
    text = (key or "").strip()
    if len(text) <= 8:
        return "••••"
    return f"{text[:4]}...{text[-3:]}"


def clamp_cooldown(seconds):
    try:
        value = int(seconds)
    except (TypeError, ValueError):
        return COOLDOWN_DEFAULT
    return max(COOLDOWN_MIN, min(COOLDOWN_MAX, value))


class KeyRotator:
    """Round-robin keys with a cooldown. Does not log key material."""

    def __init__(self, keys, cooldown_seconds=COOLDOWN_DEFAULT, clock=None):
        self.cooldown_seconds = clamp_cooldown(cooldown_seconds)
        self._clock = clock or time.time
        self._cursor = 0
        seen = set()
        self._entries = []
        for key in keys or []:
            cleaned = (key or "").strip()
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            self._entries.append({
                "slot": len(self._entries) + 1,
                "key": cleaned,
                "blocked_until": 0.0,
            })

    def __len__(self):
        return len(self._entries)

    def acquire(self):
        if not self._entries:
            raise RuntimeError("No Gemini API keys configured. Add one in Settings. Nothing is hardcoded.")
        now = self._clock()
        available = [entry for entry in self._entries if entry["blocked_until"] <= now]
        if not available:
            soonest = min(entry["blocked_until"] for entry in self._entries)
            wait = max(1, int(math.ceil(soonest - now)))
            raise RuntimeError(f"All Gemini API keys are cooling down. Retry in {wait}s.")
        start = self._cursor % len(self._entries)
        for offset in range(len(self._entries)):
            entry = self._entries[(start + offset) % len(self._entries)]
            if entry["blocked_until"] <= now:
                self._cursor = (start + offset + 1) % len(self._entries)
                return {"slot": entry["slot"], "key": entry["key"]}
        raise RuntimeError("No Gemini API key is currently available.")

    def cool(self, slot):
        for entry in self._entries:
            if entry["slot"] == slot:
                entry["blocked_until"] = self._clock() + self.cooldown_seconds
                return

    def public_rows(self):
        now = self._clock()
        rows = []
        for entry in self._entries:
            remaining = max(0, int(math.ceil(entry["blocked_until"] - now)))
            if remaining:
                detail = f"Cooling down {remaining}s after quota or auth failure"
                state = "cooling"
            else:
                detail = "Ready"
                state = "ready"
            rows.append({
                "slot": entry["slot"],
                "masked": mask_key(entry["key"]),
                "detail": detail,
                "state": state,
                "cooldown_seconds": remaining,
            })
        return rows


def is_safety_text(text):
    lowered = (text or "").lower()
    return any(token in lowered for token in ("safety", "blocked", "prohibited", "unsafe", "policy"))


def is_unsupported_model(text, status_code=None):
    raw = text or ""
    if is_safety_text(raw):
        return False
    lowered = raw.lower()
    mentions_model = any(token in lowered for token in ("model", "omni", "veo", "gemini", "feature"))
    unsupported_bits = (
        "not supported anymore",
        "no longer supported",
        "not supported",
        "no longer available",
        "is not available",
        "unknown model",
        "invalid model",
        "does not exist",
        "has been shut",
        "shut down",
        "shutdown",
        "deprecated",
    )
    if mentions_model and any(bit in lowered for bit in unsupported_bits):
        return True
    if status_code == 404 or "not found" in lowered:
        return any(token in lowered for token in ("model", "omni", "veo"))
    return False


def is_quota_text(text, status_code=None):
    lowered = (text or "").lower()
    return status_code == 429 or any(token in lowered for token in (
        "resource_exhausted", "quota", "rate limit", "too many requests", "429",
    ))


def is_auth_text(text, status_code=None):
    lowered = (text or "").lower()
    return status_code in {401, 403} or any(token in lowered for token in (
        "api key", "permission denied", "unauthenticated", "unauthorized", "forbidden",
    ))


def is_retryable_key_error(text, status_code=None):
    """Quota, auth, and transient server errors cool the key. Safety and unsupported do not."""
    if is_safety_text(text) or is_unsupported_model(text, status_code):
        return False
    if status_code in {500, 502, 503, 504}:
        return True
    lowered = (text or "").lower()
    if any(token in lowered for token in ("temporarily unavailable", "deadline exceeded", "timed out", "internal", "unavailable")):
        return True
    return is_quota_text(text, status_code) or is_auth_text(text, status_code)


def video_user_line(kind, api_sentence, model_id):
    prefixes = {
        "access": "This Gemini key cannot generate video. Omni Flash has to be enabled for the key, and the Google account may need billing.",
        "quota": "Video quota is used up on this key. Add another key in Settings, or wait for the quota to reset.",
        "safety": "Google blocked that scene for safety. Sweety will rephrase it and try once more.",
        "unsupported": "The video model was rejected.",
        "rejected": "Gemini rejected the scene request.",
        "failed": "The scene video did not finish.",
    }
    prefix = prefixes.get(kind, prefixes["failed"])
    sentence = (api_sentence or "").strip()
    model = strip_models_prefix(model_id)
    body = f"{prefix} {model}: {sentence}".strip() if sentence else f"{prefix} {model}".strip()
    return body[:280]


def classify_video_failure(text, status_code=None):
    if is_safety_text(text) and not is_unsupported_model(text, status_code):
        return "safety"
    if is_unsupported_model(text, status_code):
        return "unsupported"
    if is_quota_text(text, status_code):
        return "quota"
    if is_auth_text(text, status_code):
        return "access"
    if status_code and status_code >= 400:
        return "rejected"
    return "failed"


def redact_secrets(text, secrets):
    cleaned = text or ""
    for secret in secrets or []:
        if secret and len(secret) >= 8:
            cleaned = cleaned.replace(secret, "[redacted]")
    return cleaned


def migrate_live_model(stored):
    bare = strip_models_prefix(stored)
    if not bare or bare in OLD_LIVE_DEFAULTS or bare in RETIRED_IDS:
        return LIVE_DEFAULT
    if bare == "gemini-3.1-flash-live-preview":
        return bare
    return bare


def migrate_text_model(stored):
    bare = strip_models_prefix(stored)
    if not bare or bare in {"gemini-2.0-flash", "gemini-2.0-flash-001"} or bare in RETIRED_IDS:
        return TEXT_DEFAULT
    if bare == "gemini-2.5-flash":
        return bare
    return bare


def migrate_video_model(stored):
    bare = strip_models_prefix(stored)
    if not bare or bare in RETIRED_IDS:
        return VIDEO_DEFAULT
    return bare


def _kind_match(model, kind):
    name = strip_models_prefix(model.get("name") or model.get("id") or "").lower()
    description = (model.get("description") or "").lower()
    if name in RETIRED_IDS:
        return False
    if kind == "video":
        return "omni" in name or name.startswith("veo") or ("video" in description and "generat" in description)
    if kind == "live":
        return "live" in name and "transcribe" not in name and "translate" not in name
    if kind == "tts":
        return "tts" in name or "text-to-speech" in description
    if kind == "text":
        methods = model.get("supportedGenerationMethods") or model.get("methods") or []
        if methods and "generateContent" not in methods:
            return False
        blocked = ("tts", "live", "omni", "veo", "image", "embedding", "transcribe", "robot")
        return not any(token in name for token in blocked)
    return False


def rank_models(discovered, kind):
    candidates = {
        "live": LIVE_CANDIDATES,
        "text": TEXT_CANDIDATES,
        "video": VIDEO_CANDIDATES,
        "tts": TTS_CANDIDATES,
    }[kind]
    names = []
    for model in discovered or []:
        if _kind_match(model, kind):
            bare = strip_models_prefix(model.get("name") or model.get("id") or "")
            if bare and bare not in names and bare not in RETIRED_IDS:
                names.append(bare)
    if not names:
        return list(candidates)
    ordered = [item for item in candidates if item in names]
    for name in names:
        if name not in ordered:
            ordered.append(name)
    return ordered or list(candidates)


def next_model(current, ordered):
    bare = strip_models_prefix(current)
    if bare not in ordered:
        return ordered[0] if ordered else bare
    index = ordered.index(bare)
    if index + 1 < len(ordered):
        return ordered[index + 1]
    return None


def film_progress(phase, scene_index=1, scene_count=1):
    count = max(1, int(scene_count or 1))
    index = max(1, int(scene_index or 1))
    if phase == "Idle":
        return 0.0, "idle"
    if phase == "Planning":
        return 0.06, f"Sweety is planning {count} scenes"
    if phase == "Rendering":
        fraction = 0.10 + 0.55 * (index - 1) / count
        return fraction, f"Rendering scene {index} of {count}"
    if phase == "Voiceover":
        return 0.72, "Recording the narration"
    if phase == "Stitching":
        return 0.84, "Stitching the scenes"
    if phase == "Captions":
        return 0.92, "Burning in the captions"
    if phase == "Saving":
        return 0.97, "Saving to Movies/ADA"
    if phase == "Ready":
        return 1.0, "Complete. Saved to Movies/ADA."
    if phase == "Error":
        return 0.0, "Cancelled."
    return 0.0, phase


def content_percent(phase, fraction):
    if phase in {"Idle", "Error"}:
        return 0
    if phase == "Ready":
        return 100
    return max(1, min(99, int(fraction * 100)))


BUSY_PHASES = {"Planning", "Rendering", "Voiceover", "Stitching", "Captions", "Saving"}


def generate_enabled(phase):
    return phase not in BUSY_PHASES


def interaction_body(model, prompt, aspect="9:16"):
    return {
        "model": strip_models_prefix(model) or VIDEO_DEFAULT,
        "input": prompt,
        "generation_config": {"video_config": {"task": "text_to_video"}},
        "response_format": {
            "type": "video",
            "aspect_ratio": aspect_ratio(aspect),
            "duration": "8s",
            "delivery": "uri",
        },
    }


def _walk_strings(node, found):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in {"text", "output", "content"} and isinstance(value, str):
                found.append(value)
            else:
                _walk_strings(value, found)
    elif isinstance(node, list):
        for item in node:
            _walk_strings(item, found)


def _walk_uris(node, found):
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, str) and key.lower() in {"uri", "url", "download_uri", "file_uri"}:
                found.append(value)
            elif isinstance(value, str) and value.startswith("http") and "file" in key.lower():
                found.append(value)
            else:
                _walk_uris(value, found)
    elif isinstance(node, list):
        for item in node:
            _walk_uris(item, found)


def extract_inline_video(node):
    if isinstance(node, dict):
        data = node.get("data") or node.get("bytesBase64Encoded")
        mime = str(node.get("mime_type") or node.get("mimeType") or "")
        if isinstance(data, str) and "video" in mime:
            return data
        for value in node.values():
            found = extract_inline_video(value)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = extract_inline_video(item)
            if found:
                return found
    return None


def parse_interaction(payload):
    """Return a video locator, or the text step when Omni finished without a file."""
    uris = []
    _walk_uris(payload, uris)
    inline = extract_inline_video(payload)
    texts = []
    _walk_strings(payload, texts)
    joined = "\n".join(texts).strip()
    if uris:
        return {"ok": True, "uri": uris[0], "inline": inline, "text": joined}
    if inline:
        return {"ok": True, "uri": "", "inline": inline, "text": joined}
    status = ""
    if isinstance(payload, dict):
        status = str(payload.get("status") or payload.get("state") or "")
    if joined:
        return {"ok": False, "uri": "", "inline": None, "text": joined, "status": status}
    return {"ok": False, "uri": "", "inline": None, "text": "", "status": status}


def should_retry_safety(original, rewrite):
    rewritten = (rewrite or "").strip()
    if not rewritten:
        return False
    return rewritten != (original or "").strip()


def draft_script(topic, niche, tone, style, length_seconds):
    length = int(length_seconds or 60)
    length = max(15, min(180, length))
    title = (topic or niche or "Untitled").strip()
    return (
        f"{title}\n\n"
        f"Niche: {niche}. Tone: {tone}. Style: {style}. Length: {length} seconds.\n\n"
        f"Visual: Open on {title}, {style} light.\n"
        f"Voiceover: {tone.capitalize()} lines about {title}.\n"
        f"Caption: {title[:72]}\n"
    )
