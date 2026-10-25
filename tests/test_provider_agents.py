"""Tests for Runway, InVideo, local digital products, and social posting."""
import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from digital_product_agent import DigitalProductAgent
from provider_http import HttpResult
from social_media_agent import SocialMediaAgent
from video_agent import VideoAgent


class FakeHttp:
    def __init__(self, handlers):
        self.handlers = handlers
        self.calls = []

    def __call__(self, method, url, headers=None, body=None, timeout=120):
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "body": body})
        for predicate, response in self.handlers:
            if predicate(method, url):
                status, header_map, payload = response
                if isinstance(payload, (dict, list)):
                    raw = json.dumps(payload).encode("utf-8")
                elif isinstance(payload, str):
                    raw = payload.encode("utf-8")
                else:
                    raw = payload
                return HttpResult(status, header_map, raw)
        return HttpResult(404, {}, b'{"error":"unmatched"}')


def _ok(payload, headers=None):
    return 200, headers or {}, payload


@pytest.mark.asyncio
async def test_runway_saves_video(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNWAYML_API_KEY", "runway-key")
    http = FakeHttp([
        (lambda method, url: method == "POST" and url.endswith("/text_to_video"), _ok({"id": "task_1"})),
        (lambda method, url: "/tasks/task_1" in url, _ok({"status": "SUCCEEDED", "output": ["https://cdn.example/clip.mp4"]})),
        (lambda method, url: url.startswith("https://cdn.example/"), _ok(b"mp4-bytes")),
    ])
    agent = VideoAgent(output_dir=tmp_path, http_request=http, poll_interval_seconds=0, max_polls=3)

    result = await agent.generate_long_form_video("A brass gear turning", "runway", 1)

    saved = list(tmp_path.glob("runway_generation_*.mp4"))
    assert saved and saved[0].read_bytes() == b"mp4-bytes"
    assert "saved to" in result
    assert "not implemented" not in result.lower()


@pytest.mark.asyncio
async def test_runway_reports_provider_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNWAYML_API_KEY", "runway-key")
    http = FakeHttp([
        (lambda method, url: url.endswith("/text_to_video"), _ok({"id": "task_2"})),
        (lambda method, url: "/tasks/task_2" in url, _ok({"status": "FAILED", "failure": "credits exhausted"})),
    ])
    agent = VideoAgent(output_dir=tmp_path, http_request=http, poll_interval_seconds=0, max_polls=2)

    result = await agent.generate_long_form_video("A cube", "runway", 1)

    assert "credits exhausted" in result
    assert list(tmp_path.glob("*.mp4")) == []


@pytest.mark.asyncio
async def test_runway_and_invideo_require_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("RUNWAYML_API_KEY", raising=False)
    monkeypatch.delenv("RUNWAYML_API_SECRET", raising=False)
    monkeypatch.delenv("INVIDEO_API_KEY", raising=False)
    agent = VideoAgent(output_dir=tmp_path, http_request=FakeHttp([]))

    runway = await agent.generate_long_form_video("A cube", "runway", 1)
    invideo = await agent.generate_long_form_video("A cube", "invideo", 1)

    assert "RUNWAYML_API_KEY" in runway
    assert "INVIDEO_API_KEY" in invideo
    assert "did not generate" in runway
    assert "did not generate" in invideo


@pytest.mark.asyncio
async def test_invideo_downloads_returned_url(tmp_path, monkeypatch):
    monkeypatch.setenv("INVIDEO_API_KEY", "iv-key")
    http = FakeHttp([
        (lambda method, url: "chatgpt-new-from-brief" in url, _ok({"video_url": "https://cdn.example/invideo.mp4"})),
        (lambda method, url: url.startswith("https://cdn.example/invideo"), _ok(b"invideo-bytes")),
    ])
    agent = VideoAgent(output_dir=tmp_path, http_request=http)

    result = await agent.generate_long_form_video("Explain gears in one minute", "invideo", 2)

    saved = list(tmp_path.glob("invideo_generation_*.mp4"))
    assert saved and saved[0].read_bytes() == b"invideo-bytes"
    assert "saved to" in result


@pytest.mark.asyncio
async def test_digital_products_are_real_files(tmp_path, monkeypatch):
    monkeypatch.delenv("CANVA_ACCESS_TOKEN", raising=False)
    agent = DigitalProductAgent(output_dir=tmp_path, http_request=FakeHttp([]))

    presentation = await agent.create_digital_product("Gear guide\nShow the teeth\nShow the bore", "canva", "presentation")
    flyer = await agent.create_digital_product("Shop flyer\nOpen Saturday", "canva", "flyer")
    document = await agent.create_digital_product("Build notes\nUse 12mm stock", "canva", "document")

    pptx = next(tmp_path.glob("*.pptx"))
    png = next(tmp_path.glob("*.png"))
    pdf = next(tmp_path.glob("*.pdf"))
    assert pptx.stat().st_size > 0 and "ppt/slides/slide1.xml" in __import__("zipfile").ZipFile(pptx).namelist()
    assert png.stat().st_size > 0
    assert pdf.read_bytes().startswith(b"%PDF")
    assert "Created presentation" in presentation
    assert "CANVA_ACCESS_TOKEN" in presentation
    assert "Created flyer" in flyer
    assert "Created document" in document


@pytest.mark.asyncio
async def test_canva_design_url_is_included(tmp_path, monkeypatch):
    monkeypatch.setenv("CANVA_ACCESS_TOKEN", "canva-token")
    http = FakeHttp([
        (lambda method, url: url.endswith("/designs"), _ok({"design": {"urls": {"edit_url": "https://www.canva.com/design/abc/edit"}}})),
    ])
    agent = DigitalProductAgent(output_dir=tmp_path, http_request=http)

    result = await agent.create_digital_product("Launch plan", "canva", "presentation")

    assert "https://www.canva.com/design/abc/edit" in result
    assert list(tmp_path.glob("*.pptx"))


@pytest.mark.asyncio
async def test_social_missing_tokens_do_not_claim_success(monkeypatch):
    for name in (
        "FACEBOOK_PAGE_ID",
        "FACEBOOK_PAGE_ACCESS_TOKEN",
        "INSTAGRAM_USER_ID",
        "INSTAGRAM_ACCESS_TOKEN",
        "TIKTOK_ACCESS_TOKEN",
        "YOUTUBE_ACCESS_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)
    agent = SocialMediaAgent(http_request=FakeHttp([]))

    result = await agent.livestream_or_post("facebook, instagram, tiktok, youtube", "post", "Hello")

    assert result.count("nothing was posted") == 4
    assert "posted. Id" not in result


@pytest.mark.asyncio
async def test_facebook_text_post(monkeypatch):
    monkeypatch.setenv("FACEBOOK_PAGE_ID", "page1")
    monkeypatch.setenv("FACEBOOK_PAGE_ACCESS_TOKEN", "fb-token")
    http = FakeHttp([
        (lambda method, url: url.endswith("/feed"), _ok({"id": "page1_99"})),
    ])
    agent = SocialMediaAgent(http_request=http)

    result = await agent.livestream_or_post("facebook", "post", "Shop is open")

    assert "facebook: posted. Id page1_99." in result
    assert http.calls[0]["headers"]["Authorization"] == "Bearer fb-token"


@pytest.mark.asyncio
async def test_youtube_resumable_upload(tmp_path, monkeypatch):
    monkeypatch.setenv("YOUTUBE_ACCESS_TOKEN", "yt-token")
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"video-bytes")
    http = FakeHttp([
        (lambda method, url: method == "POST" and "upload/youtube" in url, (200, {"Location": "https://upload.example/session"}, {})),
        (lambda method, url: method == "PUT" and url.startswith("https://upload.example/"), _ok({"id": "yt123"})),
    ])
    agent = SocialMediaAgent(http_request=http)

    result = await agent.livestream_or_post("youtube", "video", str(video))

    assert "youtube: video uploaded. Id yt123." in result
    assert "private" in result


@pytest.mark.asyncio
async def test_tiktok_and_instagram_video_upload(tmp_path, monkeypatch):
    monkeypatch.setenv("TIKTOK_ACCESS_TOKEN", "tt-token")
    monkeypatch.setenv("INSTAGRAM_USER_ID", "ig1")
    monkeypatch.setenv("INSTAGRAM_ACCESS_TOKEN", "ig-token")
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"reel-bytes")
    http = FakeHttp([
        (lambda method, url: "tiktokapis.com" in url and url.endswith("/init/"), _ok({"data": {"publish_id": "pub1", "upload_url": "https://upload.tiktok.example/v"}})),
        (lambda method, url: url.startswith("https://upload.tiktok.example/"), _ok({})),
        (lambda method, url: url.endswith("/media"), _ok({"id": "container1", "uri": "https://rupload.facebook.com/ig-api-upload/container1"})),
        (lambda method, url: "rupload.facebook.com" in url, _ok({})),
        (lambda method, url: url.endswith("/media_publish"), _ok({"id": "media1"})),
    ])
    agent = SocialMediaAgent(http_request=http)

    tiktok = await agent.livestream_or_post("tiktok", "video", str(video))
    instagram = await agent.livestream_or_post("instagram", "video", str(video))

    assert "tiktok: video submitted. Publish id pub1." in tiktok
    assert "instagram: reel published. Id media1." in instagram


@pytest.mark.asyncio
async def test_livestream_setup(monkeypatch):
    monkeypatch.setenv("FACEBOOK_PAGE_ID", "page1")
    monkeypatch.setenv("FACEBOOK_PAGE_ACCESS_TOKEN", "fb-token")
    monkeypatch.setenv("YOUTUBE_ACCESS_TOKEN", "yt-token")
    monkeypatch.setenv("INSTAGRAM_USER_ID", "ig1")
    monkeypatch.setenv("INSTAGRAM_ACCESS_TOKEN", "ig-token")
    monkeypatch.setenv("TIKTOK_ACCESS_TOKEN", "tt-token")
    http = FakeHttp([
        (lambda method, url: url.endswith("/live_videos"), _ok({"id": "live1", "secure_stream_url": "rtmps://facebook.example/rtmp"})),
        (lambda method, url: "liveBroadcasts?" in url, _ok({"id": "broadcast1"})),
        (lambda method, url: "liveStreams?" in url, _ok({"id": "stream1", "cdn": {"ingestionInfo": {"ingestionAddress": "rtmp://youtube.example/live", "streamName": "key1"}}})),
        (lambda method, url: "liveBroadcasts/bind" in url, _ok({"id": "broadcast1"})),
    ])
    agent = SocialMediaAgent(http_request=http)

    result = await agent.livestream_or_post("facebook, youtube, instagram, tiktok", "livestream", "Shop live")

    assert "rtmps://facebook.example/rtmp" in result
    assert "rtmp://youtube.example/live/key1" in result
    assert "instagram: no public API" in result
    assert "tiktok: no public API" in result
