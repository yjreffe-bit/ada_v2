import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

from provider_http import http_request

class VideoAgent:
    def __init__(self, output_dir=None, veo_client=None, poll_interval_seconds=10, http_request=None, max_polls=120):
        self.runway_api_key = os.getenv("RUNWAYML_API_KEY") or os.getenv("RUNWAYML_API_SECRET")
        self.invideo_api_key = os.getenv("INVIDEO_API_KEY")
        self.veo_api_key = os.getenv("VEO_API_KEY") or os.getenv("GEMINI_API_KEY")
        self.veo_model = os.getenv("VEO_MODEL", "veo-3.1-generate-preview")
        self.runway_model = os.getenv("RUNWAY_MODEL", "gen4.5")
        self.poll_interval_seconds = max(0, int(poll_interval_seconds))
        self.max_polls = max_polls
        self._veo_client = veo_client
        self._http = http_request or globals()["http_request"]
        
        # Output directory setup
        self.output_dir = Path(output_dir) if output_dir else Path.home() / "Videos" / "ADA_3.1"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    async def generate_long_form_video(self, prompt, platform="veo", duration_minutes=1):
        """
        Connects to various Video AI generation platforms to create long-form videos.
        """
        print(f"[VIDEO AGENT] Request to generate {duration_minutes}-minute video on {platform}...")
        print(f"[VIDEO AGENT] Prompt: {prompt}")

        platform_name = (platform or "").strip().lower()
        if not prompt or not prompt.strip():
            return "Video prompt is required before ADA can generate a video."

        if platform_name == "runway":
            return await self._generate_runway(prompt, duration_minutes)
        elif platform_name == "invideo":
            return await self._generate_invideo(prompt, duration_minutes)
        elif platform_name in ["veo", "veo3", "veo 3", "veo 3.1"]:
            return await self._generate_veo(prompt, duration_minutes)
        else:
            return f"Platform {platform} is not fully supported yet. Please choose Runway, InVideo, or Veo."

    def _runway_key(self):
        return os.getenv("RUNWAYML_API_KEY") or os.getenv("RUNWAYML_API_SECRET") or self.runway_api_key

    def _invideo_key(self):
        return os.getenv("INVIDEO_API_KEY") or self.invideo_api_key

    async def _generate_runway(self, prompt, duration_minutes):
        api_key = self._runway_key()
        if not api_key:
            return "RunwayML API key is missing. Add RUNWAYML_API_KEY (or RUNWAYML_API_SECRET). ADA did not generate a video."

        duration_seconds = self._resolve_runway_duration_seconds(duration_minutes)
        payload = {
            "model": self.runway_model,
            "promptText": prompt[:1000],
            "ratio": "1280:720",
            "duration": duration_seconds,
        }
        try:
            created = await asyncio.to_thread(
                self._http,
                "POST",
                "https://api.dev.runwayml.com/v1/text_to_video",
                {
                    "Authorization": f"Bearer {api_key}",
                    "X-Runway-Version": "2024-11-06",
                    "Content-Type": "application/json",
                },
                json.dumps(payload).encode("utf-8"),
            )
        except Exception as exc:
            return f"RunwayML video generation failed before a task was created: {exc}"

        if created.status >= 400:
            return f"RunwayML rejected the video request ({created.status}): {created.text()[:500]}"

        task_id = (created.json() or {}).get("id")
        if not task_id:
            return "RunwayML did not return a task id, so ADA cannot claim a video was generated."

        task = await self._poll_runway_task(api_key, task_id)
        if isinstance(task, str):
            return task

        output = task.get("output") or []
        if not output:
            return "RunwayML finished without an output URL, so no video file was saved."

        video_url = output[0]
        output_path = self.output_dir / self._build_output_filename("runway")
        try:
            await asyncio.to_thread(self._download_to, video_url, output_path, None)
        except Exception as exc:
            return f"RunwayML created a video but ADA could not download it: {exc}. URL: {video_url}"

        return (
            f"RunwayML video generated and saved to: {output_path}. "
            f"Runway {self.runway_model} clips are {duration_seconds} seconds in this request."
        )

    async def _poll_runway_task(self, api_key, task_id):
        headers = {
            "Authorization": f"Bearer {api_key}",
            "X-Runway-Version": "2024-11-06",
        }
        url = f"https://api.dev.runwayml.com/v1/tasks/{task_id}"
        for _ in range(self.max_polls):
            result = await asyncio.to_thread(self._http, "GET", url, headers, None)
            if result.status >= 400:
                return f"RunwayML task check failed ({result.status}): {result.text()[:500]}"
            task = result.json()
            status = (task.get("status") or "").upper()
            if status == "SUCCEEDED":
                return task
            if status in {"FAILED", "CANCELLED"}:
                reason = task.get("failure") or task.get("failureCode") or status
                return f"RunwayML video generation {status.lower()}: {reason}"
            await asyncio.sleep(self.poll_interval_seconds)
        return "RunwayML did not finish before ADA stopped waiting, so no video was saved."

    async def _generate_invideo(self, prompt, minutes):
        api_key = self._invideo_key()
        if not api_key:
            return "InVideo API key is missing. Add INVIDEO_API_KEY. ADA did not generate a video."

        length = self._resolve_invideo_minutes(minutes)
        title = " ".join(prompt.split()[:8]) or "ADA video"
        payload = {
            "brief": prompt,
            "title": title[:120],
            "description": prompt[:500],
            "platforms": ["YouTube"],
            "audiences": ["general"],
            "length_in_minutes": length,
            "settings": "Narrated video with visuals that match the brief.",
        }
        try:
            created = await asyncio.to_thread(
                self._http,
                "POST",
                "https://pro-api.invideo.io/api/copilot/request/chatgpt-new-from-brief",
                {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json.dumps(payload).encode("utf-8"),
            )
        except Exception as exc:
            return f"InVideo video generation failed: {exc}"

        if created.status >= 400:
            return f"InVideo rejected the video request ({created.status}): {created.text()[:500]}"

        try:
            body = created.json()
        except Exception:
            return f"InVideo returned a response ADA could not read: {created.text()[:500]}"

        video_url = _find_url(body)
        if not video_url:
            return f"InVideo did not return a video URL, so ADA did not save a file. Response: {json.dumps(body)[:500]}"

        output_path = self.output_dir / self._build_output_filename("invideo")
        try:
            await asyncio.to_thread(self._download_to, video_url, output_path, None)
        except Exception as exc:
            return f"InVideo returned a video URL but ADA could not download it: {exc}. URL: {video_url}"

        return f"InVideo video generated and saved to: {output_path}. Requested length: {length} minute(s)."

    def _download_to(self, url, output_path, headers):
        result = self._http("GET", url, headers, None)
        if result.status >= 400:
            raise RuntimeError(f"download failed ({result.status}): {result.text()[:300]}")
        if not result.body:
            raise RuntimeError("download returned an empty file")
        output_path.write_bytes(result.body)
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError(f"no file was written to {output_path}")

    def _resolve_runway_duration_seconds(self, duration_minutes):
        try:
            requested = int(float(duration_minutes) * 60)
        except (TypeError, ValueError):
            requested = 5
        return min(10, max(2, requested if requested else 5))

    def _resolve_invideo_minutes(self, duration_minutes):
        try:
            requested = float(duration_minutes)
        except (TypeError, ValueError):
            requested = 1
        return min(30.0, max(0.25, requested))

    async def _generate_veo(self, prompt, duration_minutes):
        if not self.veo_api_key:
            return "Google Veo API key missing. Add VEO_API_KEY or GEMINI_API_KEY before generating videos."

        duration_seconds = self._resolve_veo_duration_seconds(duration_minutes)

        try:
            video_path = await asyncio.to_thread(self._generate_veo_sync, prompt, duration_seconds)
        except Exception as exc:
            return f"Google Veo video generation failed: {exc}"

        duration_note = "Veo in ADA currently produces short clips of up to 8 seconds per request."
        return f"Google Veo video generated successfully and saved to: {video_path}. {duration_note}"

    def _resolve_veo_duration_seconds(self, duration_minutes):
        if duration_minutes is None:
            return 8

        try:
            requested_minutes = float(duration_minutes)
        except (TypeError, ValueError):
            return 8

        requested_seconds = max(0, int(requested_minutes * 60))
        if requested_seconds <= 4:
            return 4
        if requested_seconds <= 6:
            return 6
        return 8

    def _create_veo_client(self):
        from google import genai

        return genai.Client(api_key=self.veo_api_key)

    def _get_veo_client(self):
        if self._veo_client is None:
            self._veo_client = self._create_veo_client()
        return self._veo_client

    def _generate_veo_sync(self, prompt, duration_seconds):
        from google.genai import types

        client = self._get_veo_client()
        operation = client.models.generate_videos(
            model=self.veo_model,
            prompt=prompt,
            config=types.GenerateVideosConfig(duration_seconds=str(duration_seconds)),
        )

        while not getattr(operation, "done", False):
            operation = client.operations.get(operation)
            if not getattr(operation, "done", False):
                import time
                time.sleep(self.poll_interval_seconds)

        error = getattr(operation, "error", None)
        if error:
            raise RuntimeError(getattr(error, "message", str(error)))

        response = getattr(operation, "response", None)
        generated_videos = getattr(response, "generated_videos", None) if response else None
        if not generated_videos:
            raise RuntimeError("Veo completed without returning any generated videos.")

        generated_video = generated_videos[0]
        video_file = getattr(generated_video, "video", None)
        if video_file is None:
            raise RuntimeError("Veo completed without a downloadable video file.")

        client.files.download(file=video_file)
        output_path = self.output_dir / self._build_output_filename("veo")
        video_file.save(str(output_path))

        if not output_path.exists():
            raise RuntimeError(f"Veo reported success but no file was written to {output_path}.")

        return output_path

    def _build_output_filename(self, provider_name):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"{provider_name}_generation_{timestamp}.mp4"


def _find_url(payload):
    """Return the first video URL in an InVideo JSON response."""
    if isinstance(payload, dict):
        for key in ("video_url", "download_url", "url", "exportUrl"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("http"):
                return value
        for value in payload.values():
            found = _find_url(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _find_url(value)
            if found:
                return found
    return None
