"""Desktop studio services: notes, alarms, and the Omni film job.

The film worker is driven with an injected HTTP function. Socket handlers in
server.py call into this module.
"""

import json
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from mobile_behavior import (
    NARRATOR_VOICE,
    TTS_STYLES,
    VIDEO_DEFAULT,
    aspect_ratio,
    camera_prompt,
    clamp_minutes,
    composite_prompt,
    content_director_prompt,
    content_percent,
    cost_warning,
    director_brief,
    draft_script,
    film_progress,
    generate_enabled,
    parse_finished_request,
    parse_storyboard,
    scene_count_for_minutes,
    spoken_script,
    started_line,
    sweety_prompt,
    sweety_storyboard_prompt,
    wants_make_it,
)
from omni_film import (
    OmniError,
    build_ffmpeg_command,
    download_uri,
    ffmpeg_available,
    render_with_safety,
    run_ffmpeg,
    synthesize_narration,
    video_model_order,
    write_srt,
)
from provider_http import http_request


def movies_dir():
    path = Path.home() / "Movies" / "ADA"
    path.mkdir(parents=True, exist_ok=True)
    return path


class MemoryBook:
    def __init__(self, store):
        self.store = store

    def _load(self):
        data = self.store.load() or {}
        notes = data.get("memories") or []
        return data, [note for note in notes if isinstance(note, dict)]

    def list_notes(self):
        _, notes = self._load()
        return [
            {"id": note.get("id"), "title": note.get("title") or "", "body": note.get("body") or ""}
            for note in notes
        ]

    def add(self, title, body):
        data, notes = self._load()
        note = {
            "id": uuid.uuid4().hex[:12],
            "title": (title or "Note").strip()[:80],
            "body": (body or "").strip()[:2000],
        }
        notes.append(note)
        data["memories"] = notes
        self.store.save(data)
        return note

    def delete(self, title=None, note_id=None):
        data, notes = self._load()
        kept = []
        removed = False
        for note in notes:
            match = (note_id and note.get("id") == note_id) or (title and note.get("title") == title)
            if match and not removed:
                removed = True
                continue
            kept.append(note)
        data["memories"] = kept
        self.store.save(data)
        return removed

    def search(self, query):
        words = [part.lower() for part in (query or "").split() if part]
        found = []
        for note in self.list_notes():
            haystack = f"{note['title']} {note['body']}".lower()
            if not words or all(word in haystack for word in words):
                found.append(note)
        return found

    def prompt_block(self):
        notes = self.list_notes()
        if not notes:
            return ""
        lines = ["Notes Sir asked you to remember on this computer:"]
        for note in notes:
            lines.append(f"{note['title']}: {note['body']}")
        return "\n".join(lines)


class FilmLibrary:
    def __init__(self, directory=None):
        self.directory = Path(directory) if directory else movies_dir()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db_path = self.directory / "content_studio.db"
        self._init()

    def _connect(self):
        return sqlite3.connect(self.db_path)

    def _init(self):
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS clips (
                    id TEXT PRIMARY KEY,
                    prompt TEXT,
                    style TEXT,
                    aspect TEXT,
                    duration_seconds INTEGER,
                    video_path TEXT,
                    thumb_path TEXT,
                    created_at REAL
                )
                """
            )

    def add(self, prompt, style, aspect, duration_seconds, video_path, thumb_path=""):
        row_id = uuid.uuid4().hex[:12]
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO clips VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (row_id, prompt, style, aspect, int(duration_seconds), video_path, thumb_path, time.time()),
            )
        return row_id

    def list_rows(self):
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT id, prompt, style, aspect, duration_seconds, video_path, thumb_path, created_at "
                "FROM clips ORDER BY created_at DESC"
            )
            rows = []
            for row in cursor.fetchall():
                rows.append({
                    "id": row[0],
                    "prompt": row[1],
                    "style": row[2],
                    "aspect": row[3],
                    "duration_seconds": row[4],
                    "video_path": row[5],
                    "thumb_path": row[6],
                    "created_at": row[7],
                    "name": Path(row[5]).name if row[5] else "",
                })
            return rows

    def get(self, row_id):
        for row in self.list_rows():
            if row["id"] == row_id:
                return row
        return None

    def delete(self, row_id):
        row = self.get(row_id)
        if not row:
            return False
        for key in ("video_path", "thumb_path"):
            path = row.get(key)
            if path and os.path.isfile(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
        with self._connect() as conn:
            conn.execute("DELETE FROM clips WHERE id = ?", (row_id,))
        return True


class FilmJob:
    def __init__(self, keys, library, http=None, directory=None):
        self.keys = keys
        self.library = library
        self.http = http or http_request
        self.directory = Path(directory) if directory else library.directory
        self.phase = "Idle"
        self.status = "idle"
        self.percent = 0
        self.error = ""
        self.output = ""
        self.run_id = 0
        self.running = False
        self._lock = threading.Lock()
        self.listeners = []

    def snapshot(self):
        return {
            "phase": self.phase,
            "status": self.status,
            "percent": self.percent,
            "error": self.error,
            "output": self.output,
            "running": self.running,
            "generate_enabled": generate_enabled(self.phase),
            "history": self.library.list_rows(),
        }

    def publish(self, phase, scene_index=1, scene_count=1, error=""):
        fraction, label = film_progress(phase, scene_index, scene_count)
        if phase == "Error" and error:
            label = error
        self.phase = phase
        self.status = label
        self.percent = content_percent(phase, fraction)
        self.error = error
        self.running = phase not in {"Idle", "Ready", "Error"}
        snapshot = self.snapshot()
        for listener in list(self.listeners):
            try:
                listener(snapshot)
            except Exception:
                pass
        return snapshot

    def cancel(self):
        with self._lock:
            self.run_id += 1
        self.publish("Error", error="Cancelled.")
        return self.snapshot()

    def start_form(self, form):
        with self._lock:
            if self.running:
                return {"ok": False, "message": "A video is already rendering, Sir. Wait until it finishes or cancel it."}
            self.run_id += 1
            run_id = self.run_id
            self.running = True
        self.publish("Planning", scene_count=scene_count_for_minutes(form.get("minutes") or 1))
        thread = threading.Thread(target=self._run, args=(run_id, form), daemon=True)
        thread.start()
        return {"ok": True, "run_id": run_id, "line": self._started(form)}

    def _started(self, form):
        niche = (form.get("custom_niche") or form.get("niche") or "Storytelling").strip()
        return started_line(
            clamp_minutes(form.get("minutes") or 1),
            niche,
            form.get("style") or "Cinematic",
            form.get("aspect") or "9:16 Shorts",
        )

    def _alive(self, run_id):
        return run_id == self.run_id

    def _acquire(self):
        try:
            return self.keys.acquire()
        except RuntimeError as exc:
            raise OmniError("access", str(exc))

    def _run(self, run_id, form):
        try:
            self._render(run_id, form)
        except Exception as exc:
            if self._alive(run_id):
                self.publish("Error", error=str(exc)[:280])
        finally:
            with self._lock:
                if run_id == self.run_id:
                    self.running = self.phase in {"Planning", "Rendering", "Voiceover", "Stitching", "Captions", "Saving"}

    def _render(self, run_id, form):
        minutes = clamp_minutes(form.get("minutes") or 1)
        niche = (form.get("custom_niche") or form.get("niche") or "Storytelling").strip()[:40]
        style = form.get("style") or "Cinematic"
        aspect = form.get("aspect") or "9:16 Shorts"
        narrator = form.get("narrator") or "Storyteller"
        topic = (form.get("topic") or "").strip()[:500]
        count = int(form.get("max_scenes") or 0) or scene_count_for_minutes(minutes)
        count = max(1, min(80, count))
        if not self._alive(run_id):
            return
        brief = composite_prompt(niche, topic, style, aspect, narrator, minutes) + director_brief(minutes, style)
        storyboard = self._plan(brief, count, topic, style, run_id)
        if not self._alive(run_id):
            return
        clips = []
        for index, scene in enumerate(storyboard["scenes"], start=1):
            if not self._alive(run_id):
                return
            self.publish("Rendering", index, count)
            path = self._one_clip(scene["visual"], style, aspect, index, run_id)
            clips.append(path)
        if not self._alive(run_id):
            return
        self.publish("Voiceover", scene_count=count)
        voice_path = self._voiceover(storyboard["scenes"], narrator, run_id)
        if not self._alive(run_id):
            return
        self.publish("Stitching", scene_count=count)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        output = self.directory / f"ADA-content-cv-{stamp}.mp4"
        srt = self.directory / f"ADA-content-cv-{stamp}.srt"
        write_srt(storyboard["scenes"], srt)
        crossfade = form.get("crossfade", True)
        keep_audio = bool(form.get("keep_clip_audio"))
        captions = form.get("captions", True)
        if not ffmpeg_available():
            # Keep the first clip so the render is not silently discarded.
            if clips:
                output.write_bytes(Path(clips[0]).read_bytes())
            raise RuntimeError("ffmpeg is not on PATH, so the scenes were saved individually and not stitched. Install ffmpeg and render again.")
        self.publish("Captions", scene_count=count)
        command = build_ffmpeg_command(
            clips,
            output,
            voice_path=voice_path or None,
            subtitles_path=srt if captions else None,
            crossfade=crossfade and len(clips) > 1,
            keep_clip_audio=keep_audio and not voice_path,
        )
        try:
            run_ffmpeg(command)
        except RuntimeError:
            command = build_ffmpeg_command(
                clips,
                output,
                voice_path=voice_path or None,
                subtitles_path=None,
                crossfade=crossfade and len(clips) > 1,
                keep_clip_audio=keep_audio and not voice_path,
            )
            run_ffmpeg(command)
        if not self._alive(run_id):
            return
        self.publish("Saving", scene_count=count)
        prompt = f"{storyboard['title']} — {brief}"
        self.library.add(prompt, style, aspect, minutes * 60, str(output))
        self.output = str(output)
        self.publish("Ready", scene_count=count)

    def _plan(self, brief, count, topic, style, run_id):
        acquired = self._acquire()
        model_order = ["gemini-3.8-flash"]
        text = ""
        try:
            from omni_film import _post_json
            persona = content_director_prompt(count) if count > 5 else sweety_storyboard_prompt()
            result = _post_json(
                self.http,
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
                acquired["key"],
                {"contents": [{"role": "user", "parts": [{"text": persona + "\n\n" + brief}]}]},
                90,
            )
            if result.status < 400:
                data = result.json()
                parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
                text = "".join(part.get("text") or "" for part in parts)
            elif result.status in {429, 500, 502, 503, 504}:
                self.keys.cool(acquired["slot"])
        except Exception:
            text = ""
        if not self._alive(run_id):
            return {"title": topic or "Film", "scenes": []}
        return parse_storyboard(text, count, topic, style)

    def _one_clip(self, visual, style, aspect, index, run_id):
        last_error = None
        for _ in range(max(1, len(self.keys.public_view().get("keys") or [1]))):
            if not self._alive(run_id):
                raise OmniError("failed", "Cancelled.")
            acquired = self._acquire()
            models = video_model_order(acquired["key"], http=self.http, cache={})
            try:
                rendered, _prompt, _note = render_with_safety(
                    visual,
                    style,
                    acquired["key"],
                    aspect_ratio(aspect),
                    self.http,
                    models,
                    "gemini-3.8-flash",
                    secrets=[acquired["key"]],
                )
                return self._materialize(rendered, acquired["key"], index)
            except OmniError as exc:
                last_error = exc
                if exc.kind in {"quota", "access"}:
                    self.keys.cool(acquired["slot"])
                    continue
                raise
        raise last_error or OmniError("failed", "The scene video did not finish.")

    def _materialize(self, rendered, api_key, index):
        parsed = rendered["parsed"]
        if parsed.get("inline"):
            import base64
            data = base64.b64decode(parsed["inline"])
        elif parsed.get("uri"):
            data = download_uri(parsed["uri"], api_key, http=self.http)
        else:
            raise OmniError("failed", parsed.get("text") or "The scene video did not finish.", rendered.get("model") or VIDEO_DEFAULT)
        path = self.directory / f"scene-{index}-{uuid.uuid4().hex[:6]}.mp4"
        path.write_bytes(data)
        return str(path)

    def _voiceover(self, scenes, narrator, run_id):
        script = spoken_script(scenes)
        if not script:
            return ""
        try:
            acquired = self._acquire()
        except OmniError:
            return ""
        voice = NARRATOR_VOICE.get(narrator, "Sulafat")
        style = TTS_STYLES.get(narrator, TTS_STYLES["film"])
        try:
            wav = synthesize_narration(script, acquired["key"], voice, style, http=self.http)
        except Exception:
            wav = b""
        if not wav or not self._alive(run_id):
            return ""
        path = self.directory / f"narration-{uuid.uuid4().hex[:6]}.wav"
        path.write_bytes(wav)
        return str(path)


def safe_open_app(name):
    cleaned = (name or "").strip()
    if not cleaned or re.search(r"[&|><;`$\n]", cleaned):
        return "That application name is not allowed."
    import subprocess
    import sys
    try:
        if sys.platform == "win32":
            subprocess.Popen(["cmd", "/c", "start", "", cleaned], shell=False)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-a", cleaned])
        else:
            subprocess.Popen(["xdg-open", cleaned])
    except Exception as exc:
        return f"Could not open {cleaned}. {exc}"
    return f"Opening {cleaned}."


def alarm_delay_seconds(hour, minute, now=None):
    import datetime
    clock = now or datetime.datetime.now()
    hour = max(0, min(23, int(hour)))
    minute = max(0, min(59, int(minute)))
    target = clock.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= clock:
        target = target + datetime.timedelta(days=1)
    return max(0, int((target - clock).total_seconds()))


def dispatch_local_tool(name, args, memory, schedule):
    """Handle tools that do not need Gemini. schedule(delay, message) fires later."""
    args = args or {}
    if name == "save_memory":
        note = memory.add(args.get("title"), args.get("body") or args.get("text"))
        return f"Saved {note['title']} on this computer."
    if name == "search_memory":
        found = memory.search(args.get("query") or "")
        if not found:
            return "No matching notes."
        return "; ".join(f"{note['title']}: {note['body']}" for note in found)
    if name == "delete_memory":
        removed = memory.delete(title=args.get("title"))
        return "Deleted that note." if removed else "No note with that title."
    if name == "set_timer":
        seconds = int(args.get("seconds") or 0)
        if seconds < 1 or seconds > 86400:
            return "A timer has to be between 1 and 86400 seconds."
        label = args.get("label") or "Timer"
        schedule(seconds, f"{label} is done, Sir.")
        return f"Timer set for {seconds} seconds."
    if name == "set_alarm":
        delay = alarm_delay_seconds(args.get("hour") or 0, args.get("minute") or 0)
        label = args.get("label") or "Alarm"
        schedule(delay, f"Alarm: {label}")
        return f"Alarm set, Sir."
    if name == "open_app":
        return safe_open_app(args.get("name") or "")
    if name == "draft_short_form_video":
        return draft_script(
            args.get("topic") or "",
            args.get("niche") or "tech",
            args.get("tone") or "witty",
            args.get("style") or "cinematic",
            args.get("duration_seconds") or 60,
        )
    if name in {"look_at_screen", "share_screen", "see_screen"}:
        return "Allow the system screen-share prompt, Sir. I can see the screen only after you allow it."
    return None


def sweety_reply_fallback(message):
    text = (message or "").strip()
    if not text:
        return "Say something to Sweety first."
    if wants_make_it(text):
        return "I can see it, honey. Say make it. [[MAKE_IT]]"
    return "I can see it, honey. Say make it."


def form_from_request(text):
    parsed = parse_finished_request(text)
    return {
        "niche": parsed["niche"],
        "custom_niche": parsed["custom_niche"],
        "narrator": parsed["narrator"],
        "style": parsed["style"],
        "aspect": parsed["aspect"],
        "minutes": parsed["minutes"],
        "topic": parsed["topic"],
        "crossfade": True,
        "captions": True,
        "voiceover": True,
        "keep_clip_audio": False,
    }


def warning_for(minutes):
    return cost_warning(minutes)
