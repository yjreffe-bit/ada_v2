import asyncio
import os
from datetime import datetime
from pathlib import Path

class VideoAgent:
    def __init__(self, output_dir=None, veo_client=None, poll_interval_seconds=10):
        self.runway_api_key = os.getenv("RUNWAYML_API_KEY")
        self.invideo_api_key = os.getenv("INVIDEO_API_KEY")
        self.veo_api_key = os.getenv("VEO_API_KEY") or os.getenv("GEMINI_API_KEY")
        self.veo_model = os.getenv("VEO_MODEL", "veo-3.1-generate-preview")
        self.poll_interval_seconds = max(1, int(poll_interval_seconds))
        self._veo_client = veo_client
        
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
            return await self._generate_runway(prompt)
        elif platform_name == "invideo":
            return await self._generate_invideo(prompt, duration_minutes)
        elif platform_name in ["veo", "veo3", "veo 3", "veo 3.1"]:
            return await self._generate_veo(prompt, duration_minutes)
        else:
            return f"Platform {platform} is not fully supported yet. Please choose Runway, InVideo, or Veo."

    async def _generate_runway(self, prompt):
        if not self.runway_api_key:
            return "RunwayML API key is missing. Add RUNWAYML_API_KEY. ADA will not claim a video was generated until the provider integration is implemented."

        return "RunwayML generation is not implemented in this ADA build yet. Configure a real provider integration before treating Runway video requests as completed."

    async def _generate_invideo(self, prompt, minutes):
        if not self.invideo_api_key:
            return "InVideo API key is missing. Add INVIDEO_API_KEY. ADA will not claim a video was generated until the provider integration is implemented."

        return "InVideo generation is not implemented in this ADA build yet. Configure a real provider integration before treating InVideo requests as completed."

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
