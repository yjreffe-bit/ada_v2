import asyncio
import json
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path

from provider_http import HttpResult, http_request

GRAPH_VERSION = "v22.0"


class SocialMediaAgent:
    """Publishes to Facebook, Instagram, TikTok, and YouTube when tokens are set.

    Text posts go to a Facebook Page. Video uploads use each platform's official
    content API. Livestream setup is available for YouTube and Facebook, which
    return an RTMP ingest URL. Instagram and TikTok do not offer that API.
    YouTube uploads and TikTok posts stay private unless the privacy env vars
    say otherwise.
    """

    def __init__(self, http_request=None):
        self._http = http_request or globals()["http_request"]

    async def livestream_or_post(self, platform, content_type, filepath_or_text):
        platforms = [item.strip().lower() for item in (platform or "").split(",") if item.strip()]
        if not platforms:
            return "Name at least one platform: facebook, instagram, tiktok, or youtube."

        kind = (content_type or "post").strip().lower()
        if kind not in {"post", "video", "livestream"}:
            return f"ADA does not know content type '{content_type}'. Use post, video, or livestream."

        results = []
        for name in platforms:
            results.append(await self._publish_one(name, kind, filepath_or_text or ""))
        return " ".join(results)

    async def _publish_one(self, platform, kind, payload):
        handlers = {
            "facebook": self._facebook,
            "instagram": self._instagram,
            "tiktok": self._tiktok,
            "youtube": self._youtube,
        }
        handler = handlers.get(platform)
        if handler is None:
            return f"{platform}: unsupported platform."
        try:
            return await handler(kind, payload)
        except Exception as exc:
            return f"{platform}: failed before the provider accepted the request: {exc}"

    async def _facebook(self, kind, payload):
        page_id = os.getenv("FACEBOOK_PAGE_ID", "").strip()
        token = os.getenv("FACEBOOK_PAGE_ACCESS_TOKEN", "").strip()
        if not page_id or not token:
            return "facebook: missing FACEBOOK_PAGE_ID or FACEBOOK_PAGE_ACCESS_TOKEN, so nothing was posted."

        path = _existing_file(payload)
        if kind == "livestream":
            result = await self._json(
                "POST",
                f"https://graph.facebook.com/{GRAPH_VERSION}/{page_id}/live_videos",
                token,
                {"title": _title(payload, "ADA live"), "status": "LIVE_NOW"},
            )
            if _failed(result):
                return f"facebook: livestream was not created ({result.status}): {result.text()[:300]}"
            body = result.json()
            stream_url = body.get("secure_stream_url") or body.get("stream_url")
            if not stream_url:
                return "facebook: the live video was created but no RTMP URL was returned."
            return f"facebook: livestream is ready. Send video to {stream_url}. Live id {body.get('id')}."

        if path and path.suffix.lower() in {".mp4", ".mov", ".m4v"}:
            result = await asyncio.to_thread(self._facebook_video, page_id, token, path, payload)
        elif kind == "video":
            return "facebook: a video file path is required, and that file was not found."
        else:
            message = payload if not path else path.read_text(encoding="utf-8", errors="replace")[:5000]
            result = await self._json(
                "POST",
                f"https://graph.facebook.com/{GRAPH_VERSION}/{page_id}/feed",
                token,
                {"message": message},
            )
        if _failed(result):
            return f"facebook: post was rejected ({result.status}): {result.text()[:300]}"
        post_id = (result.json() or {}).get("id")
        if not post_id:
            return "facebook: the request finished without a post id, so ADA cannot confirm it."
        return f"facebook: posted. Id {post_id}."

    def _facebook_video(self, page_id, token, path, description):
        boundary = "----adaSocialBoundary"
        file_bytes = path.read_bytes()
        preamble = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="description"\r\n\r\n{_title(description, path.stem)}\r\n'
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="source"; filename="{path.name}"\r\n'
            f"Content-Type: video/mp4\r\n\r\n"
        ).encode("utf-8")
        body = preamble + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
        return self._http(
            "POST",
            f"https://graph.facebook.com/{GRAPH_VERSION}/{page_id}/videos",
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            body,
        )

    async def _instagram(self, kind, payload):
        user_id = os.getenv("INSTAGRAM_USER_ID", "").strip()
        token = os.getenv("INSTAGRAM_ACCESS_TOKEN", "").strip()
        if not user_id or not token:
            return "instagram: missing INSTAGRAM_USER_ID or INSTAGRAM_ACCESS_TOKEN, so nothing was posted."
        if kind == "livestream":
            return "instagram: no public API lets ADA start a livestream. Upload a video instead."

        path = _existing_file(payload)
        if path is None or path.suffix.lower() not in {".mp4", ".mov", ".m4v"}:
            return "instagram: a local video file is required. Text-only Instagram posts are not available through this API."

        created = await self._json(
            "POST",
            f"https://graph.facebook.com/{GRAPH_VERSION}/{user_id}/media",
            token,
            {
                "media_type": "REELS",
                "upload_type": "resumable",
                "caption": _title(payload, path.stem)[:2200],
            },
        )
        if _failed(created):
            return f"instagram: container was rejected ({created.status}): {created.text()[:300]}"
        container = created.json() or {}
        container_id = container.get("id")
        upload_uri = container.get("uri")
        if not container_id or not upload_uri:
            return "instagram: the container response did not include an upload URI."

        file_bytes = path.read_bytes()
        uploaded = await asyncio.to_thread(
            self._http,
            "POST",
            upload_uri,
            {
                "Authorization": f"OAuth {token}",
                "offset": "0",
                "file_size": str(len(file_bytes)),
                "Content-Type": "application/octet-stream",
            },
            file_bytes,
        )
        if _failed(uploaded):
            return f"instagram: video upload failed ({uploaded.status}): {uploaded.text()[:300]}"

        published = await self._json(
            "POST",
            f"https://graph.facebook.com/{GRAPH_VERSION}/{user_id}/media_publish",
            token,
            {"creation_id": container_id},
        )
        if _failed(published):
            return f"instagram: publish failed ({published.status}): {published.text()[:300]}"
        media_id = (published.json() or {}).get("id")
        if not media_id:
            return "instagram: publish finished without a media id, so ADA cannot confirm it."
        return f"instagram: reel published. Id {media_id}."

    async def _tiktok(self, kind, payload):
        token = os.getenv("TIKTOK_ACCESS_TOKEN", "").strip()
        if not token:
            return "tiktok: missing TIKTOK_ACCESS_TOKEN, so nothing was posted."
        if kind == "livestream":
            return "tiktok: no public API lets ADA start a livestream. Upload a video instead."

        path = _existing_file(payload)
        if path is None or path.suffix.lower() not in {".mp4", ".mov", ".webm"}:
            return "tiktok: a local video file is required. Text-only TikTok posts are not available through this API."

        video_size = path.stat().st_size
        if video_size > 64_000_000:
            return "tiktok: ADA uploads videos up to 64 MB in one request. This file is larger, so it was not posted."
        if video_size == 0:
            return "tiktok: the video file is empty, so it was not posted."
        privacy = os.getenv("TIKTOK_PRIVACY_LEVEL", "SELF_ONLY").strip() or "SELF_ONLY"
        init = await self._json(
            "POST",
            "https://open.tiktokapis.com/v2/post/publish/video/init/",
            token,
            {
                "post_info": {
                    "title": _title(payload, path.stem)[:150],
                    "privacy_level": privacy,
                    "disable_duet": False,
                    "disable_comment": False,
                    "disable_stitch": False,
                },
                "source_info": {
                    "source": "FILE_UPLOAD",
                    "video_size": video_size,
                    "chunk_size": video_size,
                    "total_chunk_count": 1,
                },
            },
        )
        if _failed(init):
            return f"tiktok: upload init failed ({init.status}): {init.text()[:300]}"
        data = (init.json() or {}).get("data") or {}
        upload_url = data.get("upload_url")
        publish_id = data.get("publish_id")
        if not upload_url or not publish_id:
            return f"tiktok: init did not return an upload URL. Response: {init.text()[:300]}"

        file_bytes = path.read_bytes()
        uploaded = await asyncio.to_thread(
            self._http,
            "PUT",
            upload_url,
            {
                "Content-Type": mimetypes.guess_type(path.name)[0] or "video/mp4",
                "Content-Length": str(len(file_bytes)),
                "Content-Range": f"bytes 0-{len(file_bytes) - 1}/{len(file_bytes)}",
            },
            file_bytes,
        )
        if _failed(uploaded):
            return f"tiktok: file upload failed ({uploaded.status}): {uploaded.text()[:300]}"
        return f"tiktok: video submitted. Publish id {publish_id}. Privacy {privacy}."

    async def _youtube(self, kind, payload):
        token = os.getenv("YOUTUBE_ACCESS_TOKEN", "").strip()
        if not token:
            return "youtube: missing YOUTUBE_ACCESS_TOKEN, so nothing was posted."
        privacy = os.getenv("YOUTUBE_PRIVACY", "private").strip() or "private"

        if kind == "livestream":
            title = _title(payload, "ADA live")
            start_time = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            broadcast = await self._json(
                "POST",
                "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails",
                token,
                {
                    "snippet": {"title": title, "scheduledStartTime": start_time},
                    "status": {"privacyStatus": privacy},
                    "contentDetails": {"enableAutoStart": True, "enableAutoStop": True},
                },
            )
            if _failed(broadcast):
                return f"youtube: livestream broadcast was rejected ({broadcast.status}): {broadcast.text()[:300]}"
            broadcast_id = (broadcast.json() or {}).get("id")
            stream = await self._json(
                "POST",
                "https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,cdn",
                token,
                {
                    "snippet": {"title": title},
                    "cdn": {"frameRate": "30fps", "ingestionType": "rtmp", "resolution": "720p"},
                },
            )
            if _failed(stream):
                return f"youtube: livestream stream was rejected ({stream.status}): {stream.text()[:300]}"
            stream_body = stream.json() or {}
            stream_id = stream_body.get("id")
            ingestion = ((stream_body.get("cdn") or {}).get("ingestionInfo") or {})
            address = ingestion.get("ingestionAddress")
            stream_name = ingestion.get("streamName")
            if not broadcast_id or not stream_id or not address or not stream_name:
                return "youtube: livestream setup did not return an RTMP address."
            bound = await self._json(
                "POST",
                f"https://www.googleapis.com/youtube/v3/liveBroadcasts/bind?id={broadcast_id}&part=id,contentDetails&streamId={stream_id}",
                token,
                {},
            )
            if _failed(bound):
                return f"youtube: broadcast was created but binding the stream failed ({bound.status}): {bound.text()[:300]}"
            return f"youtube: livestream is ready. Send video to {address}/{stream_name}. Broadcast id {broadcast_id}. Privacy {privacy}."

        path = _existing_file(payload)
        if path is None or path.suffix.lower() not in {".mp4", ".mov", ".m4v", ".webm"}:
            return "youtube: a local video file is required. Text-only YouTube posts are not available through this API."

        metadata = {
            "snippet": {"title": _title(payload, path.stem)[:100], "description": "Uploaded by ADA."},
            "status": {"privacyStatus": privacy},
        }
        file_bytes = path.read_bytes()
        started = await asyncio.to_thread(
            self._http,
            "POST",
            "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": mimetypes.guess_type(path.name)[0] or "video/mp4",
                "X-Upload-Content-Length": str(len(file_bytes)),
            },
            json.dumps(metadata).encode("utf-8"),
        )
        if _failed(started):
            return f"youtube: upload session was rejected ({started.status}): {started.text()[:300]}"
        location = started.headers.get("location")
        if not location:
            return "youtube: upload session did not return a Location header."
        uploaded = await asyncio.to_thread(
            self._http,
            "PUT",
            location,
            {"Authorization": f"Bearer {token}", "Content-Type": mimetypes.guess_type(path.name)[0] or "video/mp4"},
            file_bytes,
        )
        if _failed(uploaded):
            return f"youtube: video upload failed ({uploaded.status}): {uploaded.text()[:300]}"
        video_id = (uploaded.json() or {}).get("id")
        if not video_id:
            return "youtube: upload finished without a video id, so ADA cannot confirm it."
        return f"youtube: video uploaded. Id {video_id}. Privacy {privacy}."

    async def _json(self, method, url, token, payload):
        return await asyncio.to_thread(
            self._http,
            method,
            url,
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json.dumps(payload).encode("utf-8"),
        )


def _existing_file(payload):
    if not payload:
        return None
    candidate = Path(str(payload)).expanduser()
    if candidate.is_file():
        return candidate
    return None


def _title(payload, fallback):
    text = str(payload or "").strip()
    if not text or _existing_file(text):
        return fallback
    return " ".join(text.split())[:120] or fallback


def _failed(result: HttpResult):
    return result.status >= 400
