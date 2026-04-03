import asyncio
import json
import os
import tempfile
import textwrap
import uuid
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

from gemini_key_manager import GeminiKeyManager

load_dotenv()


class VideoContentAgent:
    def __init__(self, on_update=None, on_key_status=None):
        self.model = "gemini-3-pro-preview"
        self.on_update = on_update
        self.on_key_status = on_key_status
        self.key_manager = GeminiKeyManager(http_options={"api_version": "v1beta"}, cooldown_seconds=120)

    def _emit_update(self, payload):
        if self.on_update:
            self.on_update(payload)

    def _emit_key_status(self, slot, source, state, message):
        if self.on_key_status:
            self.on_key_status({
                "slot": slot,
                "source": source,
                "state": state,
                "message": message,
            })

    async def _generate_blueprint(self, request):
        prompt = f"""
Create a JSON-only short-form content video blueprint.

Requirements:
- Minimum duration: {max(90, int(request['duration_seconds']))} seconds.
- Topic: {request['topic']}
- Niche: {request['niche']}
- Narrator style: {request['narrator_style']}
- Video style: {request['video_style']}
- Include intro: {request['include_intro']}
- Include outro: {request['include_outro']}
- Aspect ratio: {request['aspect_ratio']}
- Target platforms: {', '.join(request['platform_targets'])}

Return strict JSON with this shape:
{{
  "title": "...",
  "hook": "...",
  "description": "...",
  "hashtags": ["#..."],
  "cta": "...",
  "thumbnail_text": "...",
  "narrator_notes": "...",
  "scenes": [
    {{
      "heading": "...",
      "narration": "...",
      "on_screen_text": "...",
      "visual_direction": "...",
      "duration_seconds": 12
    }}
  ]
}}

Rules:
- The sum of scene durations must be at least the required minimum.
- Make 8 to 12 scenes.
- Keep each narration segment natural for voiceover.
- Make the first 3 seconds a strong hook.
- Tailor visuals and pacing to the requested style.
- Do not wrap the JSON in markdown.
"""

        last_error = None
        for _ in range(len(self.key_manager._entries)):
            entry = await self.key_manager.acquire()
            self._emit_key_status(entry["slot"], "video-content", "active", "Generating content blueprint")
            try:
                response = await entry["client"].aio.models.generate_content(
                    model=self.model,
                    contents=prompt,
                )
                await self.key_manager.release_success(entry)
                text = response.text or ""
                return self._normalize_blueprint(text, request)
            except Exception as error:
                last_error = error
                await self.key_manager.report_failure(entry, error)
                self._emit_key_status(entry["slot"], "video-content", "cooldown", f"Switching Gemini key after error: {self.key_manager.describe_error(error)}")
                if not self.key_manager.is_retryable_error(error):
                    raise

        if last_error:
            raise last_error
        raise RuntimeError("No Gemini key was available to build the video blueprint.")

    def _normalize_blueprint(self, response_text, request):
        cleaned = response_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()

        data = json.loads(cleaned)
        scenes = data.get("scenes") or []
        required_total = max(90, int(request["duration_seconds"]))
        total = sum(max(6, int(scene.get("duration_seconds", 10))) for scene in scenes)
        if total < required_total and scenes:
            deficit = required_total - total
            bump = max(1, deficit // len(scenes))
            for scene in scenes:
                scene["duration_seconds"] = max(6, int(scene.get("duration_seconds", 10))) + bump

        data["scenes"] = scenes
        data.setdefault("title", request["topic"].title())
        data.setdefault("description", f"Auto-generated content video for {request['topic']}")
        data.setdefault("hashtags", ["#content", "#ada"])
        data.setdefault("cta", "Follow for more.")
        data.setdefault("thumbnail_text", data["title"])
        data.setdefault("narrator_notes", f"{request['narrator_style']} narrator")
        return data

    def _build_scene_image(self, size, style, scene, index, total):
        from PIL import Image, ImageDraw, ImageFont, ImageFilter

        width, height = size
        palettes = {
            "cinematic": ((12, 18, 30), (176, 93, 56), (230, 225, 210)),
            "anime": ((28, 22, 52), (255, 95, 162), (243, 245, 255)),
            "realistic": ((16, 28, 22), (88, 152, 120), (245, 244, 238)),
            "documentary": ((24, 24, 24), (220, 180, 90), (245, 245, 245)),
            "neon": ((10, 16, 28), (60, 210, 255), (235, 248, 255)),
        }
        base, accent, text = palettes.get(style, palettes["cinematic"])
        image = Image.new("RGB", (width, height), base)
        draw = ImageDraw.Draw(image)

        for step in range(8):
            inset = step * 14
            draw.rounded_rectangle(
                [inset, inset, width - inset, height - inset],
                radius=32,
                outline=tuple(min(255, c + step * 3) for c in accent),
                width=2,
            )

        try:
            title_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size=max(28, width // 24))
            body_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size=max(22, width // 42))
            small_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size=max(16, width // 60))
        except Exception:
            title_font = ImageFont.load_default()
            body_font = ImageFont.load_default()
            small_font = ImageFont.load_default()

        heading = textwrap.fill(scene.get("heading", f"Scene {index + 1}"), width=18)
        caption = textwrap.fill(scene.get("on_screen_text", scene.get("narration", "")), width=32)
        direction = textwrap.fill(scene.get("visual_direction", ""), width=40)

        draw.text((width * 0.08, height * 0.1), heading, fill=text, font=title_font, spacing=6)
        draw.text((width * 0.08, height * 0.42), caption, fill=text, font=body_font, spacing=8)
        draw.text((width * 0.08, height * 0.78), direction, fill=tuple(max(0, c - 30) for c in text), font=small_font, spacing=6)
        draw.text((width * 0.84, height * 0.08), f"{index + 1}/{total}", fill=accent, font=small_font)

        glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        glow_draw = ImageDraw.Draw(glow)
        glow_draw.ellipse([width * 0.62, height * 0.12, width * 0.95, height * 0.45], fill=accent + (90,))
        glow = glow.filter(ImageFilter.GaussianBlur(48))
        image = Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB")
        return image

    def _synthesize_narration(self, lines, output_dir):
        try:
            import pyttsx3
        except Exception:
            return None, "pyttsx3 is not installed; generated a silent preview video."

        try:
            narration_path = os.path.join(output_dir, "narration.wav")
            engine = pyttsx3.init()
            engine.setProperty("rate", 168)
            engine.save_to_file(" ".join(lines), narration_path)
            engine.runAndWait()
            if os.path.exists(narration_path):
                return narration_path, None
        except Exception as error:
            return None, f"Narration generation failed: {error}"

        return None, "Narration engine did not create an audio file."

    def _render_video_package(self, blueprint, request, output_dir):
        import numpy as np
        from moviepy.editor import AudioFileClip, CompositeAudioClip, ImageClip, concatenate_videoclips

        size = (1080, 1920) if request["aspect_ratio"] == "9:16" else (1280, 720)
        clips = []
        scene_images = []

        scenes = list(blueprint.get("scenes", []))
        if request["include_intro"]:
            scenes.insert(0, {
                "heading": blueprint.get("title", request["topic"]),
                "on_screen_text": blueprint.get("hook", request["topic"]),
                "visual_direction": f"{request['video_style']} intro card",
                "narration": blueprint.get("hook", request["topic"]),
                "duration_seconds": 6,
            })
        if request["include_outro"]:
            scenes.append({
                "heading": "Call To Action",
                "on_screen_text": blueprint.get("cta", "Follow for more."),
                "visual_direction": "Outro card with subscribe and follow prompt",
                "narration": blueprint.get("cta", "Follow for more."),
                "duration_seconds": 6,
            })

        for index, scene in enumerate(scenes):
            image = self._build_scene_image(size, request["video_style"], scene, index, len(scenes))
            frame_path = os.path.join(output_dir, f"scene_{index + 1:02d}.png")
            image.save(frame_path)
            scene_images.append(frame_path)
            duration = max(6, int(scene.get("duration_seconds", 10)))
            clips.append(ImageClip(np.array(image)).set_duration(duration).fadein(0.35).fadeout(0.35))

        final_video = concatenate_videoclips(clips, method="compose")

        narration_path, narration_warning = self._synthesize_narration(
            [scene.get("narration", "") for scene in scenes if scene.get("narration")],
            output_dir,
        )
        if narration_path:
            audio_clip = AudioFileClip(narration_path)
            if audio_clip.duration < final_video.duration:
                audio_clip = audio_clip.set_duration(final_video.duration)
            final_video = final_video.set_audio(CompositeAudioClip([audio_clip]))

        video_path = os.path.join(output_dir, "preview.mp4")
        final_video.write_videofile(
            video_path,
            fps=24,
            codec="libx264",
            audio_codec="aac",
            temp_audiofile=os.path.join(output_dir, "temp-audio.m4a"),
            remove_temp=True,
            logger=None,
        )
        final_video.close()

        return {
            "video_path": video_path,
            "scene_images": scene_images,
            "narration_warning": narration_warning,
            "duration_seconds": sum(max(6, int(scene.get("duration_seconds", 10))) for scene in scenes),
        }

    async def generate_video(self, request, output_dir=None):
        self._emit_update({"status": "planning", "message": "Building script and storyboard..."})
        blueprint = await self._generate_blueprint(request)

        work_dir = output_dir or os.path.join(tempfile.gettempdir(), f"ada_video_{uuid.uuid4().hex[:8]}")
        Path(work_dir).mkdir(parents=True, exist_ok=True)

        metadata_path = os.path.join(work_dir, "video_blueprint.json")
        with open(metadata_path, "w", encoding="utf-8") as handle:
            json.dump(blueprint, handle, indent=2)

        self._emit_update({"status": "rendering", "message": "Rendering preview video locally...", "blueprint": blueprint})
        render_result = await asyncio.to_thread(self._render_video_package, blueprint, request, work_dir)

        upload_links = {
            "youtube": "https://studio.youtube.com/channel/UC/videos/upload",
            "facebook": "https://www.facebook.com/reels/create/",
            "tiktok": "https://www.tiktok.com/upload?lang=en",
            "instagram": "https://www.instagram.com/create/select/",
        }

        result = {
            "status": "completed",
            "title": blueprint.get("title", request["topic"]),
            "topic": request["topic"],
            "description": blueprint.get("description", ""),
            "hashtags": blueprint.get("hashtags", []),
            "thumbnail_text": blueprint.get("thumbnail_text", ""),
            "cta": blueprint.get("cta", ""),
            "narrator_notes": blueprint.get("narrator_notes", ""),
            "scenes": blueprint.get("scenes", []),
            "request": request,
            "video_path": render_result["video_path"],
            "metadata_path": metadata_path,
            "preview_url": render_result["video_path"],
            "duration_seconds": render_result["duration_seconds"],
            "narration_warning": render_result.get("narration_warning"),
            "upload_links": upload_links,
            "created_at": datetime.utcnow().isoformat() + "Z",
        }
        self._emit_update(result)
        return result