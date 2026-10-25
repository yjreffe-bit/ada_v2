"""OAuth Connect logins use mocked provider endpoints. No live network calls."""

import base64
import json
import os
from urllib.parse import parse_qs, urlparse

import pytest

from oauth_connections import (
    CANVA_SCOPES,
    CANVA_TOKEN_URL,
    DEFAULT_CLIENT_IDS,
    OAuthError,
    YOUTUBE_SCOPES,
    ConnectionManager,
    callback_page,
    redact_secrets_in_text,
    s256_challenge,
    set_manager,
)
from provider_http import HttpResult
from social_media_agent import SocialMediaAgent
from token_store import TokenStore, default_token_path


class FakeHttp:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, url, headers=None, body=None, timeout=120):
        self.calls.append({
            "method": method,
            "url": url,
            "headers": headers or {},
            "body": body or b"",
        })
        for predicate, result in self.routes:
            if predicate(method, url):
                return result
        return HttpResult(404, {}, b'{"error":"not found"}')


def _ok(payload, status=200, headers=None):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    return HttpResult(status, headers or {}, body)


def _form(call):
    return parse_qs(call["body"].decode("utf-8"))


def _clear_overrides(monkeypatch):
    for name in (
        "CANVA_ACCESS_TOKEN",
        "YOUTUBE_ACCESS_TOKEN",
        "FACEBOOK_PAGE_ID",
        "FACEBOOK_PAGE_ACCESS_TOKEN",
        "INSTAGRAM_USER_ID",
        "INSTAGRAM_ACCESS_TOKEN",
        "TIKTOK_ACCESS_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def clock():
    state = {"now": 1_700_000_000}
    return state


@pytest.fixture
def manager(tmp_path, clock):
    store = TokenStore(path=tmp_path / "oauth_tokens.json", prefer_keyring=False, keyring_module=None)
    http = FakeHttp([])
    built = ConnectionManager(
        store=store,
        http_request=http,
        now=lambda: clock["now"],
        redirect_base_url="http://127.0.0.1:8000",
    )
    set_manager(built)
    yield built
    set_manager(None)


def test_default_token_file_is_outside_the_repo():
    path = os.path.abspath(default_token_path())
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    assert path != repo
    assert not path.startswith(repo + os.sep)
    assert os.path.basename(path) == "oauth_tokens.json"


def test_file_store_is_private_and_keyring_is_preferred(tmp_path):
    path = tmp_path / "oauth_tokens.json"
    file_store = TokenStore(path=path, prefer_keyring=False, keyring_module=None)
    file_store.save({"canva": {"access_token": "file-token", "refresh_token": "file-refresh"}})
    assert path.read_text(encoding="utf-8")
    if os.name != "nt":
        assert (path.stat().st_mode & 0o777) == 0o600
    assert file_store.load()["canva"]["access_token"] == "file-token"

    class FakeKeyring:
        def __init__(self):
            self.data = {}

        def get_password(self, service, user):
            return self.data.get((service, user))

        def set_password(self, service, user, password):
            self.data[(service, user)] = password

        def delete_password(self, service, user):
            self.data.pop((service, user), None)

    keyring = FakeKeyring()
    key_path = tmp_path / "should-not-exist.json"
    secure = TokenStore(path=key_path, keyring_module=keyring, prefer_keyring=True)
    secure.save({"youtube": {"access_token": "ring-token"}})
    assert not key_path.exists()
    assert secure.load()["youtube"]["access_token"] == "ring-token"
    secure.clear()
    assert secure.load() == {}


def test_log_redaction_hides_codes_and_bearer_tokens():
    raw = "GET /oauth/canva/callback?code=secret-code&state=abc Authorization: Bearer access-token-value"
    cleaned = redact_secrets_in_text(raw)
    assert "secret-code" not in cleaned
    assert "access-token-value" not in cleaned
    assert "code=[redacted]" in cleaned
    page = callback_page("ADA connected", "Canva is connected.")
    assert "access_token" not in page
    assert "<script>" not in callback_page("ADA", "<script>alert(1)</script>")


def test_canva_pkce_state_and_refresh(manager, clock, monkeypatch):
    _clear_overrides(monkeypatch)
    monkeypatch.setenv("CANVA_CLIENT_ID", "canva-id")
    monkeypatch.setenv("CANVA_CLIENT_SECRET", "canva-secret")
    http = manager.http
    http.routes = [
        (lambda method, url: url == CANVA_TOKEN_URL, _ok({
            "access_token": "canva-access",
            "refresh_token": "canva-refresh",
            "expires_in": 14400,
            "token_type": "Bearer",
        })),
    ]

    started = manager.begin("canva")
    query = parse_qs(urlparse(started["url"]).query)
    assert query["code_challenge_method"] == ["S256"]
    assert query["redirect_uri"] == ["http://127.0.0.1:8000/oauth/canva/callback"]
    assert query["scope"] == [CANVA_SCOPES]
    assert "canva-secret" not in started["url"]

    with pytest.raises(OAuthError):
        manager.finish("canva", {"code": "auth-code", "state": "not-the-state"})
    assert http.calls == []

    manager.finish("canva", {"code": "auth-code", "state": query["state"][0]})
    sent = _form(http.calls[0])
    assert sent["grant_type"] == ["authorization_code"]
    assert sent["code_verifier"][0]
    assert s256_challenge(sent["code_verifier"][0], "base64url") == query["code_challenge"][0]
    expected_basic = "Basic " + base64.b64encode(b"canva-id:canva-secret").decode("ascii")
    assert http.calls[0]["headers"]["Authorization"] == expected_basic

    with pytest.raises(OAuthError):
        manager.finish("canva", {"code": "auth-code", "state": query["state"][0]})
    assert len(http.calls) == 1

    status = json.dumps(manager.public_status())
    assert "canva-access" not in status
    assert "canva-refresh" not in status
    assert "Canva is connected." in manager.describe()

    clock["now"] = 1_700_000_000 + 14400
    http.routes = [
        (lambda method, url: url == CANVA_TOKEN_URL, _ok({
            "access_token": "canva-access-2",
            "refresh_token": "canva-refresh-2",
            "expires_in": 14400,
        })),
    ]
    assert manager.canva_access_token() == "canva-access-2"
    refresh = _form(http.calls[-1])
    assert refresh["grant_type"] == ["refresh_token"]
    assert refresh["refresh_token"] == ["canva-refresh"]
    assert manager.canva_access_token() == "canva-access-2"
    assert len(http.calls) == 2
    assert manager.store.load()["canva"]["refresh_token"] == "canva-refresh-2"


def test_manual_canva_token_overrides_the_saved_login(manager, monkeypatch):
    _clear_overrides(monkeypatch)
    manager.store.save({
        "canva": {"access_token": "saved", "refresh_token": "saved-refresh", "expires_at": 1},
    })
    monkeypatch.setenv("CANVA_ACCESS_TOKEN", "manual-token")
    assert manager.canva_access_token() == "manual-token"
    assert manager.http.calls == []
    row = next(item for item in manager.public_status() if item["id"] == "canva")
    assert row["source"] == "manual"
    assert "manual-token" not in json.dumps(row)


def test_youtube_offline_access_and_refresh_keeps_old_refresh_token(manager, clock, monkeypatch):
    _clear_overrides(monkeypatch)
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "google-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "google-secret")
    http = manager.http
    http.routes = [
        (lambda method, url: "oauth2.googleapis.com/token" in url, _ok({
            "access_token": "yt-access",
            "refresh_token": "yt-refresh",
            "expires_in": 3600,
        })),
        (lambda method, url: "youtube/v3/channels" in url, _ok({
            "items": [{"snippet": {"title": "Jeff's channel"}}],
        })),
    ]
    started = manager.begin("youtube")
    query = parse_qs(urlparse(started["url"]).query)
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["scope"] == [YOUTUBE_SCOPES]
    assert "google-secret" not in started["url"]

    message = manager.finish("youtube", {"code": "yt-code", "state": query["state"][0]})["message"]
    assert "Jeff's channel" in message
    sent = _form(http.calls[0])
    assert s256_challenge(sent["code_verifier"][0], "base64url") == query["code_challenge"][0]

    clock["now"] += 3600
    http.routes = [
        (lambda method, url: "oauth2.googleapis.com/token" in url, _ok({
            "access_token": "yt-access-2",
            "expires_in": 3600,
        })),
    ]
    assert manager.youtube_access_token() == "yt-access-2"
    assert manager.store.load()["youtube"]["refresh_token"] == "yt-refresh"


def test_tiktok_pkce_uses_hex_challenge(manager, monkeypatch):
    _clear_overrides(monkeypatch)
    monkeypatch.setenv("TIKTOK_CLIENT_KEY", "tt-key")
    monkeypatch.setenv("TIKTOK_CLIENT_SECRET", "tt-secret")
    http = manager.http
    http.routes = [
        (lambda method, url: url.startswith("https://open.tiktokapis.com/v2/oauth/token"), _ok({
            "access_token": "tt-access",
            "refresh_token": "tt-refresh",
            "expires_in": 86400,
            "open_id": "open-1",
        })),
    ]
    started = manager.begin("tiktok")
    query = parse_qs(urlparse(started["url"]).query)
    assert query["code_challenge_method"] == ["S256"]
    assert query["client_key"] == ["tt-key"]
    assert "tt-secret" not in started["url"]
    manager.finish("tiktok", {"code": "tt-code", "state": query["state"][0]})
    sent = _form(http.calls[0])
    assert s256_challenge(sent["code_verifier"][0], "hex") == query["code_challenge"][0]
    assert sent["client_key"] == ["tt-key"]
    assert manager.tiktok_access_token() == "tt-access"


def test_meta_exchanges_long_lived_user_token_and_derives_page_and_instagram(manager, clock, monkeypatch):
    _clear_overrides(monkeypatch)
    monkeypatch.setenv("META_APP_ID", "meta-id")
    monkeypatch.setenv("META_APP_SECRET", "meta-secret")
    http = manager.http
    responses = [
        _ok({"access_token": "short-user", "expires_in": 3600}),
        _ok({"access_token": "long-user", "expires_in": 5_184_000}),
        _ok({"data": [{"id": "page1", "name": "Ada Shop", "access_token": "page-token"}]}),
        _ok({"instagram_business_account": {"id": "ig1"}}),
    ]

    def meta_http(method, url, headers=None, body=None, timeout=120):
        http.calls.append({"method": method, "url": url, "headers": headers or {}, "body": body or b""})
        return responses.pop(0)

    manager.http = meta_http
    started = manager.begin("meta")
    query = parse_qs(urlparse(started["url"]).query)
    assert "code_challenge" not in query
    assert query["state"][0]
    assert "meta-secret" not in started["url"]
    message = manager.finish("meta", {"code": "meta-code", "state": query["state"][0]})["message"]
    assert "Ada Shop" in message
    assert "Instagram is connected" in message
    code_body = _form(http.calls[0])
    long_body = _form(http.calls[1])
    assert code_body["code"] == ["meta-code"]
    assert "code_verifier" not in code_body
    assert long_body["grant_type"] == ["fb_exchange_token"]
    assert long_body["fb_exchange_token"] == ["short-user"]
    assert "meta-secret" not in message

    saved = manager.store.load()["meta"]
    assert saved["page_id"] == "page1"
    assert saved["page_access_token"] == "page-token"
    assert saved["instagram_user_id"] == "ig1"
    status = json.dumps(manager.public_status())
    assert "page-token" not in status
    assert "long-user" not in status

    clock["now"] = saved["user_expires_at"] - 3600
    refreshed = [
        _ok({"access_token": "long-user-2", "expires_in": 5_184_000}),
        _ok({"data": [{"id": "page1", "name": "Ada Shop", "access_token": "page-token-2"}]}),
        _ok({"instagram_business_account": {"id": "ig1"}}),
    ]

    def refresh_http(method, url, headers=None, body=None, timeout=120):
        http.calls.append({"method": method, "url": url, "headers": headers or {}, "body": body or b""})
        return refreshed.pop(0)

    manager.http = refresh_http
    before = len(http.calls)
    assert manager.facebook_credentials() == ("page1", "page-token-2")
    assert manager.instagram_credentials() == ("ig1", "page-token-2")
    assert _form(http.calls[before])["grant_type"] == ["fb_exchange_token"]
    assert _form(http.calls[before])["fb_exchange_token"] == ["long-user"]


def test_provider_errors_do_not_echo_the_client_secret(manager, monkeypatch):
    _clear_overrides(monkeypatch)
    monkeypatch.setenv("CANVA_CLIENT_ID", "canva-id")
    monkeypatch.setenv("CANVA_CLIENT_SECRET", "canva-secret-value")

    def explode(method, url, headers=None, body=None, timeout=120):
        raise RuntimeError("network failed for canva-secret-value")

    manager.http = explode
    started = manager.begin("canva")
    state = parse_qs(urlparse(started["url"]).query)["state"][0]
    with pytest.raises(OAuthError) as caught:
        manager.finish("canva", {"code": "auth-code", "state": state})
    assert "canva-secret-value" not in str(caught.value)


def test_missing_app_credentials_do_not_open_a_login(manager, monkeypatch):
    _clear_overrides(monkeypatch)
    monkeypatch.delenv("CANVA_CLIENT_ID", raising=False)
    monkeypatch.delenv("CANVA_CLIENT_SECRET", raising=False)
    with pytest.raises(OAuthError) as caught:
        manager.begin("canva")
    assert "CANVA_CLIENT_ID" in str(caught.value)
    assert "CANVA_CLIENT_SECRET" in str(caught.value)


def test_disconnect_removes_the_saved_meta_login(manager, monkeypatch):
    _clear_overrides(monkeypatch)
    manager.store.save({
        "meta": {
            "page_id": "page1",
            "page_name": "Ada Shop",
            "page_access_token": "page-token",
            "instagram_user_id": "ig1",
            "user_access_token": "user-token",
            "user_expires_at": 9_999_999_999,
        }
    })
    assert next(item for item in manager.public_status() if item["id"] == "facebook")["connected"]
    manager.disconnect("facebook")
    assert manager.store.load() == {}
    assert not next(item for item in manager.public_status() if item["id"] == "instagram")["connected"]


@pytest.mark.asyncio
async def test_youtube_upload_uses_the_saved_login(manager, tmp_path, monkeypatch):
    _clear_overrides(monkeypatch)
    manager.store.save({
        "youtube": {
            "access_token": "stored-yt",
            "refresh_token": "stored-refresh",
            "expires_at": 9_999_999_999,
        }
    })
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"video-bytes")
    http = FakeHttp([
        (lambda method, url: method == "POST" and "upload/youtube" in url, HttpResult(200, {"Location": "https://upload.example/session"}, b"")),
        (lambda method, url: method == "PUT" and url.startswith("https://upload.example/"), _ok({"id": "yt123"})),
    ])
    agent = SocialMediaAgent(http_request=http)

    result = await agent.livestream_or_post("youtube", "video", str(video))

    assert "youtube: video uploaded. Id yt123." in result
    assert http.calls[0]["headers"]["Authorization"] == "Bearer stored-yt"


def test_settings_can_store_app_credentials_without_showing_the_secret(manager, monkeypatch):
    _clear_overrides(monkeypatch)
    monkeypatch.delenv("CANVA_CLIENT_ID", raising=False)
    monkeypatch.delenv("CANVA_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("META_APP_ID", raising=False)
    monkeypatch.delenv("META_APP_SECRET", raising=False)

    youtube = next(row for row in manager.public_status() if row["id"] == "youtube")
    meta = next(row for row in manager.public_status() if row["id"] == "facebook")
    instagram = next(row for row in manager.public_status() if row["id"] == "instagram")
    assert youtube["client_id"] == DEFAULT_CLIENT_IDS["youtube"]
    assert youtube["client_id"].endswith(".apps.googleusercontent.com")
    assert youtube["client_id_source"] == "default"
    assert youtube["secret_set"] is False
    assert meta["client_id"] == "1707614080243828"
    assert meta["redirect_uri"] == "http://127.0.0.1:8000/oauth/meta/callback"
    assert instagram["redirect_uri"] == meta["redirect_uri"]
    assert instagram["client_id"] == meta["client_id"]

    manager.save_app_credentials("canva", "canva-id", "panel-secret-value")
    manager.save_app_credentials("canva", "canva-id-2", "")
    assert manager.client_pair("canva") == ("canva-id-2", "panel-secret-value")
    status = json.dumps(manager.public_status())
    assert "panel-secret-value" not in status
    assert "canva-id-2" in status

    monkeypatch.setenv("CANVA_CLIENT_ID", "env-canva-id")
    monkeypatch.setenv("CANVA_CLIENT_SECRET", "env-canva-secret")
    assert manager.client_pair("canva") == ("env-canva-id", "env-canva-secret")
    row = next(item for item in manager.public_status() if item["id"] == "canva")
    assert row["client_id_source"] == "env"
    assert row["secret_source"] == "env"
    assert "env-canva-secret" not in json.dumps(row)

    manager.store.save({
        **manager.store.load(),
        "canva": {"access_token": "tok", "refresh_token": "ref", "expires_at": 9_999_999_999},
    })
    manager.disconnect("canva")
    saved = manager.store.load()
    assert "canva" not in saved
    assert saved["app_credentials"]["canva"]["client_secret"] == "panel-secret-value"
