"""Gemini Omni film pipeline: one clip, safety rewrite, stitch plan.

HTTP is injected so tests never call Gemini. ffmpeg is used only when a
caller asks to run a plan.
"""

import base64
import json
import shutil
import subprocess
import time
from pathlib import Path

from mobile_behavior import (
    SAFETY_REPHRASE,
    SAFETY_SECOND_FAIL,
    TTS_DEFAULT,
    VIDEO_DEFAULT,
    camera_prompt,
    classify_video_failure,
    interaction_body,
    is_retryable_key_error,
    is_unsupported_model,
    parse_interaction,
    rank_models,
    redact_secrets,
    should_retry_safety,
    strip_models_prefix,
    video_user_line,
)
from provider_http import http_request


IN_PROGRESS = {"in_progress", "processing", "running", "pending", "queued"}


class OmniError(Exception):
    def __init__(self, kind, message, model_id=""):
        super().__init__(message)
        self.kind = kind
        self.model_id = model_id


def tts_body(text, voice, style):
    return {
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"voice": voice or "Sulafat"},
                "speech_metadata": {"style": style},
            },
        },
    }


def list_models(api_key, http=None, page_limit=3):
    request = http or http_request
    found = []
    token = ""
    for _ in range(page_limit):
        url = f"https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key={api_key}"
        if token:
            url += f"&pageToken={token}"
        result = request("GET", url, timeout=30)
        if result.status >= 400:
            break
        payload = result.json()
        found.extend(payload.get("models") or [])
        token = payload.get("nextPageToken") or ""
        if not token:
            break
    return found


def video_model_order(api_key, http=None, cache=None):
    now = time.time()
    if cache and cache.get("expires", 0) > now and cache.get("order"):
        return cache["order"]
    try:
        discovered = list_models(api_key, http=http) if api_key else []
    except Exception:
        discovered = []
    order = rank_models(discovered, "video")
    if cache is not None:
        cache["expires"] = now + 600
        cache["order"] = order
    return order


def _post_json(http, url, api_key, payload, timeout):
    body = json.dumps(payload).encode("utf-8")
    return http(
        "POST",
        url,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        body=body,
        timeout=timeout,
    )


def render_omni_clip(prompt, api_key, aspect="9:16", http=None, models=None, secrets=None):
    """Try each video model. Unsupported continues. Safety raises OmniError."""
    request = http or http_request
    order = list(models or [VIDEO_DEFAULT])
    sentences = []
    secret_list = list(secrets or [])
    if api_key:
        secret_list.append(api_key)
    for model in order:
        body = interaction_body(model, prompt, aspect)
        result = _post_json(
            request,
            "https://generativelanguage.googleapis.com/v1beta/interactions",
            api_key,
            body,
            timeout=180,
        )
        text = ""
        payload = {}
        try:
            payload = result.json()
        except Exception:
            text = result.text()
        if not text:
            parsed = parse_interaction(payload)
            text = parsed.get("text") or ""
            if result.status < 400 and parsed.get("ok"):
                return {"model": model, "parsed": parsed, "raw": payload}
            if not text:
                text = result.text()
        redacted = redact_secrets(text, secret_list)
        kind = classify_video_failure(redacted, result.status)
        if kind == "safety":
            raise OmniError("safety", redacted, model)
        if kind == "unsupported" or is_unsupported_model(redacted, result.status):
            sentences.append(f"{strip_models_prefix(model)}: {redacted}".strip())
            continue
        if is_retryable_key_error(redacted, result.status):
            raise OmniError(kind if kind in {"quota", "access"} else "quota", redacted, model)
        if result.status >= 400 or not parse_interaction(payload).get("ok"):
            sentences.append(f"{strip_models_prefix(model)}: {redacted}".strip())
            if kind == "unsupported":
                continue
            raise OmniError(kind, redacted, model)
        return {"model": model, "parsed": parse_interaction(payload), "raw": payload}
    joined = " | ".join(sentence for sentence in sentences if sentence) or "The video model was rejected."
    raise OmniError("unsupported", joined[:280], order[-1] if order else VIDEO_DEFAULT)


def rewrite_scene(camera_text, api_key, text_model, http=None):
    request = http or http_request
    payload = {
        "contents": [{
            "role": "user",
            "parts": [{"text": f"{SAFETY_REPHRASE}\n\n{camera_text}"}],
        }],
    }
    result = _post_json(
        request,
        f"https://generativelanguage.googleapis.com/v1beta/models/{strip_models_prefix(text_model)}:generateContent",
        api_key,
        payload,
        timeout=60,
    )
    if result.status >= 400:
        return ""
    data = result.json()
    parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
    return "".join(part.get("text") or "" for part in parts).strip()


def render_with_safety(visual, style, api_key, aspect, http, models, text_model, secrets=None):
    prompt = camera_prompt(visual, style)
    try:
        return render_omni_clip(prompt, api_key, aspect, http=http, models=models, secrets=secrets), prompt, ""
    except OmniError as exc:
        if exc.kind != "safety":
            raise
        rewritten = rewrite_scene(prompt, api_key, text_model, http=http)
        if not should_retry_safety(prompt, rewritten):
            raise OmniError("safety", exc.args[0] + SAFETY_SECOND_FAIL, exc.model_id)
        try:
            second_prompt = camera_prompt(rewritten, style)
            return render_omni_clip(second_prompt, api_key, aspect, http=http, models=models, secrets=secrets), second_prompt, ""
        except OmniError as second:
            if second.kind == "safety":
                raise OmniError("safety", second.args[0] + SAFETY_SECOND_FAIL, second.model_id)
            raise


def wav_header(pcm, rate=24000):
    import struct
    data = pcm or b""
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(data),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        rate,
        rate * 2,
        2,
        16,
        b"data",
        len(data),
    )
    return header + data


def decode_audio_payload(payload):
    """Return WAV bytes from a generateContent TTS payload, or b''."""
    parts = (((payload.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
    for part in parts:
        inline = part.get("inlineData") or part.get("inline_data") or {}
        data = inline.get("data")
        if not data:
            continue
        raw = base64.b64decode(data)
        mime = str(inline.get("mimeType") or inline.get("mime_type") or "")
        if "wav" in mime:
            return raw
        if "L16" in mime or "pcm" in mime or not mime:
            return wav_header(raw)
        return raw
    return b""


def synthesize_narration(text, api_key, voice, style, model=TTS_DEFAULT, http=None):
    request = http or http_request
    result = _post_json(
        request,
        f"https://generativelanguage.googleapis.com/v1beta/models/{strip_models_prefix(model)}:generateContent",
        api_key,
        tts_body(text, voice, style),
        timeout=120,
    )
    if result.status >= 400:
        return b""
    return decode_audio_payload(result.json())


def crossfade_filter(count, fade_seconds=0.4, clip_seconds=8.0):
    if count <= 1:
        return "[0:v]null[vout]"
    parts = []
    previous = "0:v"
    offset = clip_seconds - fade_seconds
    for index in range(1, count):
        label = "vout" if index == count - 1 else f"v{index}"
        parts.append(
            f"[{previous}][{index}:v]xfade=transition=fadeblack:duration={fade_seconds}:offset={offset:.3f}[{label}]"
        )
        previous = label
        offset += clip_seconds - fade_seconds
    return ";".join(parts)


def build_ffmpeg_command(clip_paths, output_path, voice_path=None, subtitles_path=None, crossfade=True, keep_clip_audio=False):
    if not clip_paths:
        raise ValueError("No clips to stitch.")
    command = ["ffmpeg", "-y"]
    for path in clip_paths:
        command.extend(["-i", str(path)])
    if voice_path:
        command.extend(["-i", str(voice_path)])
    filters = []
    if crossfade and len(clip_paths) > 1:
        filters.append(crossfade_filter(len(clip_paths)))
        video = "[vout]"
    else:
        if len(clip_paths) == 1:
            video = "0:v"
        else:
            inputs = "".join(f"[{index}:v]" for index in range(len(clip_paths)))
            filters.append(f"{inputs}concat=n={len(clip_paths)}:v=1:a=0[vout]")
            video = "[vout]"
    if subtitles_path:
        escaped = str(subtitles_path).replace("\\", "\\\\").replace(":", "\\:")
        filters.append(f"{video}subtitles='{escaped}'[vcap]")
        video = "[vcap]"
    if filters:
        command.extend(["-filter_complex", ";".join(filters), "-map", video])
    else:
        command.extend(["-map", "0:v"])
    if voice_path:
        voice_index = len(clip_paths)
        command.extend(["-map", f"{voice_index}:a"])
    elif keep_clip_audio and len(clip_paths) == 1:
        command.extend(["-map", "0:a?"])
    command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(output_path)])
    return command


def write_srt(scenes, path, clip_seconds=8.0):
    def stamp(ms):
        hours = ms // 3600000
        minutes = (ms % 3600000) // 60000
        seconds = (ms % 60000) // 1000
        millis = ms % 1000
        return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"

    lines = []
    for index, scene in enumerate(scenes):
        caption = (scene.get("caption") or scene.get("narration") or "").strip()
        words = caption.split()
        chunks = [" ".join(words[pos:pos + 8]) for pos in range(0, len(words), 8)] or [caption]
        start_ms = int(index * clip_seconds * 1000)
        end_ms = int((index + 1) * clip_seconds * 1000)
        slice_ms = max(1, (end_ms - start_ms) // max(1, len(chunks)))
        for chunk_index, chunk in enumerate(chunks):
            cue_start = start_ms + chunk_index * slice_ms
            cue_end = end_ms if chunk_index == len(chunks) - 1 else cue_start + slice_ms
            lines.append(str(len(lines) // 4 + 1) if False else "")
        # rebuild cleanly
    lines = []
    cue = 1
    for index, scene in enumerate(scenes):
        caption = (scene.get("caption") or scene.get("narration") or "").strip()
        words = caption.split()
        chunks = [" ".join(words[pos:pos + 8]) for pos in range(0, len(words), 8)] or [""]
        start_ms = int(index * clip_seconds * 1000)
        end_ms = int((index + 1) * clip_seconds * 1000)
        slice_ms = max(1, (end_ms - start_ms) // len(chunks))
        for chunk_index, chunk in enumerate(chunks):
            cue_start = start_ms + chunk_index * slice_ms
            cue_end = end_ms if chunk_index == len(chunks) - 1 else min(end_ms, cue_start + slice_ms)
            lines.append(str(cue))
            lines.append(f"{stamp(cue_start)} --> {stamp(cue_end)}")
            lines.append(chunk)
            lines.append("")
            cue += 1
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def ffmpeg_available():
    return shutil.which("ffmpeg") is not None


def run_ffmpeg(command):
    if not ffmpeg_available():
        raise RuntimeError("ffmpeg is not installed, so the scenes could not be stitched.")
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        tail = (completed.stderr or "")[-400:]
        raise RuntimeError(f"ffmpeg failed. {tail}")
    return completed


def save_video_bytes(data, path):
    Path(path).write_bytes(data)


def download_uri(uri, api_key, http=None):
    request = http or http_request
    headers = {}
    if api_key and "generativelanguage.googleapis.com" in uri:
        headers["x-goog-api-key"] = api_key
    result = request("GET", uri, headers=headers, timeout=180)
    if result.status >= 400:
        raise OmniError("failed", result.text()[:280])
    return result.body
