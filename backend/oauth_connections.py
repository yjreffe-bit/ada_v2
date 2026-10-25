"""One-time Connect logins for Canva, YouTube, Meta, and TikTok.

The desktop backend opens the provider login, catches the loopback redirect,
and stores the refresh token locally. Later calls refresh the access token.
Manual token environment variables still win when they are set.
"""

import base64
import hashlib
import os
import re
import secrets
import threading
import time
import urllib.parse
from html import escape
from pathlib import Path

from provider_http import http_request
from token_store import TokenStore


CANVA_AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize"
# Canva's token endpoint lives on the REST host. Authorize stays on www.canva.com.
CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token"
CANVA_SCOPES = " ".join([
    "design:content:write",
    "design:content:read",
    "design:meta:read",
    "asset:write",
    "asset:read",
    "profile:read",
])

GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
YOUTUBE_SCOPES = " ".join([
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
])

META_GRAPH_VERSION = "v22.0"
META_AUTHORIZE_URL = f"https://www.facebook.com/{META_GRAPH_VERSION}/dialog/oauth"
META_TOKEN_URL = f"https://graph.facebook.com/{META_GRAPH_VERSION}/oauth/access_token"
META_SCOPES = ",".join([
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "publish_video",
    "instagram_basic",
    "instagram_content_publish",
    "business_management",
])

TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/"
TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"
TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload"

REFRESH_SKEW_SECONDS = 120
META_REFRESH_SKEW_SECONDS = 7 * 24 * 3600
PENDING_TTL_SECONDS = 600

# Public client ids. Secrets are never given a default.
DEFAULT_CLIENT_IDS = {
    "youtube": "285674164176-dqd9ma3epassggqtgi60dofh4tfsateu.apps.googleusercontent.com",
    "meta": "1707614080243828",
}
CREDENTIALS_KEY = "app_credentials"

SERVICES = (
    {"id": "canva", "provider": "canva", "label": "Canva"},
    {"id": "youtube", "provider": "youtube", "label": "YouTube"},
    {"id": "facebook", "provider": "meta", "label": "Facebook"},
    {"id": "instagram", "provider": "meta", "label": "Instagram"},
    {"id": "tiktok", "provider": "tiktok", "label": "TikTok"},
)

_LOG_SECRET = re.compile(
    r"(?i)\b(code|access_token|refresh_token|client_secret|code_verifier|fb_exchange_token)=([^&\s\"']+)"
)
_BEARER = re.compile(r"(?i)(Bearer\s+)\S+")


class OAuthError(Exception):
    """A login or refresh failed. The message is safe to show and to log."""


def redact_secrets_in_text(text):
    if not text:
        return ""
    cleaned = _LOG_SECRET.sub(r"\1=[redacted]", str(text))
    return _BEARER.sub(r"\1[redacted]", cleaned)


def redirect_base():
    port = os.environ.get("ADA_PORT", "8000") or "8000"
    return f"http://127.0.0.1:{port}"


def redirect_uri(provider):
    return f"{redirect_base()}/oauth/{provider}/callback"


def redirect_uris():
    return [redirect_uri(name) for name in ("canva", "youtube", "meta", "tiktok")]


def s256_challenge(verifier, encoding):
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    if encoding == "hex":
        # TikTok desktop Login Kit requires the hex SHA-256, with method S256.
        return digest.hex()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _load_env_files():
    try:
        from dotenv import load_dotenv
    except Exception:
        return
    root = Path(__file__).resolve().parents[1]
    load_dotenv(root / ".env")
    load_dotenv(Path(__file__).resolve().with_name(".env"))


def _known_secrets():
    names = (
        "CANVA_CLIENT_SECRET",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "META_APP_SECRET",
        "TIKTOK_CLIENT_SECRET",
        "CANVA_ACCESS_TOKEN",
        "YOUTUBE_ACCESS_TOKEN",
        "FACEBOOK_PAGE_ACCESS_TOKEN",
        "INSTAGRAM_ACCESS_TOKEN",
        "TIKTOK_ACCESS_TOKEN",
    )
    return [os.getenv(name, "").strip() for name in names if os.getenv(name, "").strip()]


def _env(*names):
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def callback_page(title, message):
    safe_title = escape(title)
    safe_message = escape(message)
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{safe_title}</title></head>
<body style="font-family:sans-serif;background:#070b10;color:#d7fbff;padding:48px">
<h1>{safe_title}</h1>
<p>{safe_message}</p>
<p>You can close this window and return to ADA.</p>
</body></html>"""


class ConnectionManager:
    def __init__(self, store=None, http_request=None, now=None, redirect_base_url=None):
        self.store = store or TokenStore()
        self.http = http_request or globals()["http_request"]
        self.now = now or time.time
        self._redirect_base = redirect_base_url
        self._pending = {}
        self._lock = threading.RLock()

    def begin(self, provider):
        provider = (provider or "").strip().lower()
        spec = _provider_spec(provider)
        client_id, client_secret = self.client_pair(provider)
        if not client_id or not client_secret:
            raise OAuthError(
                f"Paste the {spec['id_label']} and {spec['secret_label']} in Settings. "
                f"Or set {spec['id_env']} and {spec['secret_env']} in .env."
            )
        verifier = secrets.token_urlsafe(64)
        state = secrets.token_urlsafe(32)
        challenge = s256_challenge(verifier, spec["pkce"])
        target = self._redirect(provider)
        with self._lock:
            self._drop_expired_pending()
            self._pending[state] = {
                "provider": provider,
                "verifier": verifier,
                "redirect_uri": target,
                "expires": self.now() + PENDING_TTL_SECONDS,
            }
        return {
            "provider": provider,
            "redirect_uri": target,
            "url": spec["authorize"](client_id, target, state, challenge),
        }

    def finish(self, provider, query):
        provider = (provider or "").strip().lower()
        if provider not in {"canva", "youtube", "meta", "tiktok"}:
            raise OAuthError("Unknown connection.")
        params = {str(key): value for key, value in dict(query or {}).items()}
        if params.get("error"):
            self._consume_pending(params.get("state", ""), provider)
            detail = params.get("error_description") or params.get("error")
            raise OAuthError(redact_secrets_in_text(detail)[:200] or "The login was cancelled.")

        pending = self._consume_pending(params.get("state", ""), provider)
        code = (params.get("code") or "").strip()
        if not code:
            raise OAuthError("The login did not return a code. Click Connect again.")
        try:
            record = self._exchange(provider, pending, code)
        except OAuthError:
            raise
        except Exception as exc:
            raise OAuthError(self._redact(str(exc), pending, code)) from None
        with self._lock:
            self._save_record(provider, record)
        return {"message": _success_message(provider, record)}

    def disconnect(self, service):
        provider = _service_provider(service)
        if not provider:
            raise OAuthError("Unknown connection.")
        with self._lock:
            data = self.store.load()
            data.pop(provider, None)
            self.store.save(data)

    def save_app_credentials(self, provider, client_id=None, client_secret=None):
        """Store the app id and secret. A blank secret keeps the saved one.

        None leaves that field unchanged. An empty client id clears the saved
        id so a built-in default can show again. Values already in .env still
        win when a login starts.
        """
        provider = _service_provider(provider)
        if provider not in {"canva", "youtube", "meta", "tiktok"}:
            raise OAuthError("Unknown connection.")
        with self._lock:
            data = self.store.load()
            creds = data.get(CREDENTIALS_KEY)
            if not isinstance(creds, dict):
                creds = {}
            current = dict(creds.get(provider) or {})
            if client_id is not None:
                cleaned_id = str(client_id).strip()
                if cleaned_id:
                    current["client_id"] = cleaned_id
                else:
                    current.pop("client_id", None)
            if client_secret is not None and str(client_secret).strip():
                current["client_secret"] = str(client_secret).strip()
            if current:
                creds[provider] = current
            else:
                creds.pop(provider, None)
            if creds:
                data[CREDENTIALS_KEY] = creds
            else:
                data.pop(CREDENTIALS_KEY, None)
            self.store.save(data)

    def client_pair(self, provider):
        spec = _provider_spec(provider)
        saved = self._app_credentials().get(provider) or {}
        client_id = _env(spec["id_env"]) or str(saved.get("client_id") or "").strip() or DEFAULT_CLIENT_IDS.get(provider, "")
        client_secret = _env(spec["secret_env"]) or str(saved.get("client_secret") or "").strip()
        return client_id, client_secret

    def credential_view(self, provider):
        spec = _provider_spec(provider)
        saved = self._app_credentials().get(provider) or {}
        env_id = _env(spec["id_env"])
        env_secret = _env(spec["secret_env"])
        saved_id = str(saved.get("client_id") or "").strip()
        saved_secret = str(saved.get("client_secret") or "").strip()
        default_id = DEFAULT_CLIENT_IDS.get(provider, "")
        if env_id:
            client_id, id_source = env_id, "env"
        elif saved_id:
            client_id, id_source = saved_id, "saved"
        elif default_id:
            client_id, id_source = default_id, "default"
        else:
            client_id, id_source = "", "none"
        if env_secret:
            secret_source = "env"
        elif saved_secret:
            secret_source = "saved"
        else:
            secret_source = "none"
        return {
            "client_id": client_id,
            "client_id_source": id_source,
            "secret_set": secret_source != "none",
            "secret_source": secret_source,
            "id_label": spec["id_label"],
            "secret_label": spec["secret_label"],
            "redirect_uri": self._redirect(provider),
        }

    def public_status(self):
        data = self.store.load()
        rows = []
        for spec in SERVICES:
            record = data.get(spec["provider"]) or {}
            creds = self.credential_view(spec["provider"])
            row = _public_row(spec, record, bool(creds["client_id"] and creds["secret_set"]))
            row.update(creds)
            rows.append(row)
        return rows

    def _app_credentials(self):
        creds = self.store.load().get(CREDENTIALS_KEY) or {}
        return creds if isinstance(creds, dict) else {}

    def describe(self):
        parts = []
        for row in self.public_status():
            if not row["connected"]:
                parts.append(f"{row['label']} is not connected.")
                continue
            if row["source"] == "manual":
                parts.append(f"{row['label']} is connected with a token from .env.")
                continue
            detail = row["detail"]
            if detail and detail != "Connected.":
                parts.append(f"{row['label']}: {detail}")
            else:
                parts.append(f"{row['label']} is connected.")
        return " ".join(parts)

    def canva_access_token(self):
        override = _env("CANVA_ACCESS_TOKEN")
        if override:
            return override
        return self._fresh("canva")

    def youtube_access_token(self):
        override = _env("YOUTUBE_ACCESS_TOKEN")
        if override:
            return override
        return self._fresh("youtube")

    def tiktok_access_token(self):
        override = _env("TIKTOK_ACCESS_TOKEN")
        if override:
            return override
        return self._fresh("tiktok")

    def facebook_credentials(self):
        page_id = _env("FACEBOOK_PAGE_ID")
        token = _env("FACEBOOK_PAGE_ACCESS_TOKEN")
        if page_id and token:
            return page_id, token
        record = self._ensure_meta()
        return record.get("page_id") or "", record.get("page_access_token") or ""

    def instagram_credentials(self):
        user_id = _env("INSTAGRAM_USER_ID")
        token = _env("INSTAGRAM_ACCESS_TOKEN")
        if user_id and token:
            return user_id, token
        record = self._ensure_meta()
        return record.get("instagram_user_id") or "", record.get("page_access_token") or ""

    def _fresh(self, provider):
        with self._lock:
            record = dict(self._record(provider))
            if not record:
                return ""
            if _access_is_fresh(record, self.now()):
                return record.get("access_token") or ""
            if not record.get("refresh_token"):
                return ""
            try:
                refreshed = self._refresh(provider, record)
            except OAuthError as exc:
                record["last_error"] = self._redact(str(exc))
                self._save_record(provider, record)
                return ""
            refreshed.pop("last_error", None)
            self._save_record(provider, refreshed)
            return refreshed.get("access_token") or ""

    def _ensure_meta(self):
        with self._lock:
            record = dict(self._record("meta"))
            if not record:
                return {}
            expires = record.get("user_expires_at") or 0
            needs_refresh = bool(record.get("user_access_token") and expires and expires - self.now() < META_REFRESH_SKEW_SECONDS)
            if needs_refresh:
                try:
                    record = self._refresh_meta(record)
                    record = self._derive_pages(record)
                    record.pop("last_error", None)
                except OAuthError as exc:
                    record["last_error"] = self._redact(str(exc))
                self._save_record("meta", record)
            return record

    def _exchange(self, provider, pending, code):
        if provider == "canva":
            payload = self._token_form(
                CANVA_TOKEN_URL,
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "code_verifier": pending["verifier"],
                    "redirect_uri": pending["redirect_uri"],
                },
                basic=self.client_pair("canva"),
            )
            return _bearer_record(payload, self.now())
        if provider == "youtube":
            client_id, client_secret = self.client_pair("youtube")
            payload = self._token_form(
                GOOGLE_TOKEN_URL,
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "code_verifier": pending["verifier"],
                    "redirect_uri": pending["redirect_uri"],
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
            )
            record = _bearer_record(payload, self.now())
            record["account_label"] = self._youtube_label(record.get("access_token", ""))
            return record
        if provider == "tiktok":
            client_key, client_secret = self.client_pair("tiktok")
            payload = self._token_form(
                TIKTOK_TOKEN_URL,
                {
                    "client_key": client_key,
                    "client_secret": client_secret,
                    "code": code,
                    "grant_type": "authorization_code",
                    "redirect_uri": pending["redirect_uri"],
                    "code_verifier": pending["verifier"],
                },
            )
            record = _bearer_record(payload, self.now())
            if payload.get("open_id"):
                record["open_id"] = payload["open_id"]
            if payload.get("refresh_expires_in"):
                record["refresh_expires_at"] = int(self.now()) + int(payload["refresh_expires_in"])
            record["account_label"] = self._tiktok_label(record.get("access_token", ""))
            return record
        short = self._meta_code(pending, code)
        user = self._meta_long_lived(short.get("access_token", ""))
        record = {
            "user_access_token": user.get("access_token", ""),
            "user_expires_at": int(self.now()) + int(user.get("expires_in") or 0),
        }
        return self._derive_pages(record)

    def _refresh(self, provider, record):
        if provider == "canva":
            payload = self._token_form(
                CANVA_TOKEN_URL,
                {"grant_type": "refresh_token", "refresh_token": record["refresh_token"]},
                basic=self.client_pair("canva"),
            )
            return _bearer_record(payload, self.now(), record)
        if provider == "youtube":
            client_id, client_secret = self.client_pair("youtube")
            payload = self._token_form(
                GOOGLE_TOKEN_URL,
                {
                    "grant_type": "refresh_token",
                    "refresh_token": record["refresh_token"],
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
            )
            return _bearer_record(payload, self.now(), record)
        if provider == "tiktok":
            client_key, client_secret = self.client_pair("tiktok")
            payload = self._token_form(
                TIKTOK_TOKEN_URL,
                {
                    "client_key": client_key,
                    "client_secret": client_secret,
                    "grant_type": "refresh_token",
                    "refresh_token": record["refresh_token"],
                },
            )
            refreshed = _bearer_record(payload, self.now(), record)
            if payload.get("refresh_expires_in"):
                refreshed["refresh_expires_at"] = int(self.now()) + int(payload["refresh_expires_in"])
            return refreshed
        raise OAuthError("This connection does not use a refresh token.")

    def _refresh_meta(self, record):
        client_id, client_secret = self.client_pair("meta")
        payload = self._token_form(
            META_TOKEN_URL,
            {
                "grant_type": "fb_exchange_token",
                "client_id": client_id,
                "client_secret": client_secret,
                "fb_exchange_token": record.get("user_access_token", ""),
            },
        )
        updated = dict(record)
        updated["user_access_token"] = payload.get("access_token", "")
        updated["user_expires_at"] = int(self.now()) + int(payload.get("expires_in") or 0)
        return updated

    def _meta_code(self, pending, code):
        client_id, client_secret = self.client_pair("meta")
        return self._token_form(
            META_TOKEN_URL,
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": pending["redirect_uri"],
                "code": code,
            },
        )

    def _meta_long_lived(self, short_token):
        client_id, client_secret = self.client_pair("meta")
        return self._token_form(
            META_TOKEN_URL,
            {
                "grant_type": "fb_exchange_token",
                "client_id": client_id,
                "client_secret": client_secret,
                "fb_exchange_token": short_token,
            },
        )

    def _derive_pages(self, record):
        user_token = record.get("user_access_token", "")
        listed = self._bearer_json(
            f"https://graph.facebook.com/{META_GRAPH_VERSION}/me/accounts",
            user_token,
        )
        pages = listed.get("data") or []
        page = _pick_page(pages)
        updated = dict(record)
        if not page:
            updated["page_id"] = ""
            updated["page_name"] = ""
            updated["page_access_token"] = ""
            updated["instagram_user_id"] = ""
            return updated
        updated["page_id"] = str(page.get("id") or "")
        updated["page_name"] = page.get("name") or ""
        updated["page_access_token"] = page.get("access_token") or ""
        ig = self._bearer_json(
            f"https://graph.facebook.com/{META_GRAPH_VERSION}/{updated['page_id']}?fields=instagram_business_account",
            updated["page_access_token"] or user_token,
        )
        business = ig.get("instagram_business_account") or {}
        updated["instagram_user_id"] = str(business.get("id") or "")
        return updated

    def _youtube_label(self, token):
        if not token:
            return ""
        try:
            payload = self._bearer_json(
                "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
                token,
            )
        except OAuthError:
            return ""
        items = payload.get("items") or []
        if not items:
            return ""
        return ((items[0].get("snippet") or {}).get("title") or "")[:120]

    def _tiktok_label(self, token):
        if not token:
            return ""
        try:
            payload = self._bearer_json(
                "https://open.tiktokapis.com/v2/user/info/?fields=display_name",
                token,
            )
        except OAuthError:
            return ""
        user = ((payload.get("data") or {}).get("user") or {})
        return (user.get("display_name") or "")[:120]

    def _token_form(self, url, fields, basic=None):
        headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
        if basic and basic[0] and basic[1]:
            headers["Authorization"] = _basic_auth(basic[0], basic[1])
        result = self._call("POST", url, headers, urllib.parse.urlencode(fields).encode("utf-8"), fields)
        return self._checked_json(result, fields, basic or ())

    def _bearer_json(self, url, token):
        result = self._call(
            "GET",
            url,
            {"Authorization": f"Bearer {token}", "Accept": "application/json"},
            None,
            {"access_token": token},
        )
        return self._checked_json(result, {"access_token": token})

    def _call(self, method, url, headers, body, secrets_map):
        try:
            result = self.http(method, url, headers, body)
        except Exception as exc:
            raise OAuthError(self._redact(str(exc), secrets_map)) from None
        return result

    def _checked_json(self, result, *sources):
        try:
            return _json_or_error(result)
        except OAuthError as exc:
            raise OAuthError(self._redact(str(exc), *sources)) from None

    def _redact(self, text, *sources):
        cleaned = redact_secrets_in_text(text)
        values = list(_known_secrets())
        for item in self._app_credentials().values():
            if isinstance(item, dict) and item.get("client_secret"):
                values.append(item["client_secret"])
        for source in sources:
            if isinstance(source, dict):
                values.extend(source.values())
            elif isinstance(source, (list, tuple)):
                values.extend(source)
            else:
                values.append(source)
        for value in values:
            if isinstance(value, str) and len(value) >= 8:
                cleaned = cleaned.replace(value, "[redacted]")
        return cleaned[:300]

    def _redirect(self, provider):
        base = self._redirect_base or redirect_base()
        return f"{base}/oauth/{provider}/callback"

    def _consume_pending(self, state, provider):
        if not state:
            raise OAuthError("This login does not match the Connect button ADA opened. Click Connect again.")
        with self._lock:
            pending = self._pending.get(state)
            if not pending or pending.get("provider") != provider:
                raise OAuthError("This login does not match the Connect button ADA opened. Click Connect again.")
            if pending.get("expires", 0) < self.now():
                self._pending.pop(state, None)
                raise OAuthError("This login expired. Click Connect again.")
            return self._pending.pop(state)

    def _drop_expired_pending(self):
        expired = [key for key, item in self._pending.items() if item.get("expires", 0) < self.now()]
        for key in expired:
            self._pending.pop(key, None)

    def _record(self, provider):
        return self.store.load().get(provider) or {}

    def _save_record(self, provider, record):
        data = self.store.load()
        data[provider] = record
        self.store.save(data)


def _provider_spec(provider):
    specs = {
        "canva": {
            "id_env": "CANVA_CLIENT_ID",
            "secret_env": "CANVA_CLIENT_SECRET",
            "id_label": "Client ID",
            "secret_label": "Client Secret",
            "pkce": "base64url",
            "authorize": _canva_authorize,
        },
        "youtube": {
            "id_env": "GOOGLE_OAUTH_CLIENT_ID",
            "secret_env": "GOOGLE_OAUTH_CLIENT_SECRET",
            "id_label": "Client ID",
            "secret_label": "Client Secret",
            "pkce": "base64url",
            "authorize": _youtube_authorize,
        },
        "meta": {
            "id_env": "META_APP_ID",
            "secret_env": "META_APP_SECRET",
            "id_label": "App ID",
            "secret_label": "App Secret",
            "pkce": "base64url",
            "authorize": _meta_authorize,
        },
        "tiktok": {
            "id_env": "TIKTOK_CLIENT_KEY",
            "secret_env": "TIKTOK_CLIENT_SECRET",
            "id_label": "Client Key",
            "secret_label": "Client Secret",
            "pkce": "hex",
            "authorize": _tiktok_authorize,
        },
    }
    spec = specs.get(provider)
    if spec is None:
        raise OAuthError("Unknown connection.")
    return spec


def _service_provider(service):
    name = (service or "").strip().lower()
    for spec in SERVICES:
        if spec["id"] == name or spec["provider"] == name:
            return spec["provider"]
    return ""


def _query(url, params):
    return url + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


def _canva_authorize(client_id, redirect, state, challenge):
    return _query(CANVA_AUTHORIZE_URL, {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect,
        "scope": CANVA_SCOPES,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })


def _youtube_authorize(client_id, redirect, state, challenge):
    return _query(GOOGLE_AUTHORIZE_URL, {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect,
        "scope": YOUTUBE_SCOPES,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "access_type": "offline",
        "prompt": "consent",
    })


def _meta_authorize(client_id, redirect, state, challenge):
    del challenge
    return _query(META_AUTHORIZE_URL, {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect,
        "state": state,
        "scope": META_SCOPES,
    })


def _tiktok_authorize(client_id, redirect, state, challenge):
    return _query(TIKTOK_AUTHORIZE_URL, {
        "client_key": client_id,
        "response_type": "code",
        "scope": TIKTOK_SCOPES,
        "redirect_uri": redirect,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })


def _basic_auth(client_id, client_secret):
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _json_or_error(result):
    if result.status >= 400:
        raise OAuthError(_error_text(result))
    try:
        payload = result.json()
    except Exception as exc:
        raise OAuthError("The provider returned a response ADA could not read.") from exc
    if not isinstance(payload, dict):
        raise OAuthError("The provider returned a response ADA could not read.")
    if payload.get("error"):
        raise OAuthError(_error_text(result))
    return payload


def _error_text(result):
    try:
        payload = result.json()
    except Exception:
        return f"The provider rejected the login ({result.status})."
    if isinstance(payload, dict):
        for key in ("error_description", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return redact_secrets_in_text(value)[:200]
        error = payload.get("error")
        if isinstance(error, str) and error:
            return redact_secrets_in_text(error)[:200]
        if isinstance(error, dict):
            message = error.get("message") or error.get("code")
            if message:
                return redact_secrets_in_text(str(message))[:200]
    return f"The provider rejected the login ({result.status})."


def _bearer_record(payload, now, previous=None):
    previous = previous or {}
    expires_in = int(payload.get("expires_in") or 0)
    refresh = payload.get("refresh_token") or previous.get("refresh_token") or ""
    record = {
        "access_token": payload.get("access_token") or "",
        "refresh_token": refresh,
        "expires_at": int(now) + expires_in if expires_in else int(now),
        "scope": payload.get("scope") or previous.get("scope") or "",
        "token_type": payload.get("token_type") or previous.get("token_type") or "Bearer",
    }
    if previous.get("account_label") and "account_label" not in payload:
        record["account_label"] = previous["account_label"]
    if previous.get("open_id") and not payload.get("open_id"):
        record["open_id"] = previous["open_id"]
    if previous.get("refresh_expires_at") and "refresh_expires_in" not in payload:
        record["refresh_expires_at"] = previous["refresh_expires_at"]
    return record


def _access_is_fresh(record, now):
    token = record.get("access_token")
    expires = record.get("expires_at") or 0
    return bool(token) and expires - now > REFRESH_SKEW_SECONDS


def _pick_page(pages):
    wanted = _env("FACEBOOK_PAGE_ID")
    token_override = _env("FACEBOOK_PAGE_ACCESS_TOKEN")
    if wanted and not token_override:
        for page in pages:
            if str(page.get("id")) == wanted:
                return page
    return pages[0] if pages else None


def _public_row(spec, record, client_ready):
    service = spec["id"]
    manual = _manual_connected(service)
    stored = bool(record)
    connected = False
    source = "none"
    detail = "Not connected."
    if manual:
        connected = True
        source = "manual"
        detail = "Using the token in .env. It overrides a saved login."
    elif service == "facebook" and record.get("page_access_token"):
        connected = True
        source = "oauth"
        name = record.get("page_name") or "your Page"
        detail = f"Connected to {name}."
    elif service == "instagram" and record.get("instagram_user_id") and record.get("page_access_token"):
        connected = True
        source = "oauth"
        detail = "Connected to the Instagram professional account on the Page."
    elif service == "instagram" and record.get("page_access_token"):
        detail = "Facebook is connected. This Page has no linked Instagram professional account."
    elif service in {"canva", "youtube", "tiktok"} and record:
        fresh = _access_is_fresh(record, time.time())
        if fresh or (record.get("refresh_token") and not record.get("last_error")):
            connected = True
            source = "oauth"
            label = record.get("account_label")
            detail = f"Connected as {label}." if label else "Connected."
        elif record.get("last_error"):
            detail = "Saved login could not be refreshed. Connect again."
    if not client_ready and not connected and not stored:
        spec_env = _provider_spec(spec["provider"])
        detail = f"Paste the {spec_env['id_label']} and {spec_env['secret_label']} below."
    return {
        "id": service,
        "label": spec["label"],
        "provider": spec["provider"],
        "connected": connected,
        "source": source,
        "stored": stored,
        "ready": client_ready,
        "detail": detail,
    }


def _manual_connected(service):
    if service == "canva":
        return bool(_env("CANVA_ACCESS_TOKEN"))
    if service == "youtube":
        return bool(_env("YOUTUBE_ACCESS_TOKEN"))
    if service == "facebook":
        return bool(_env("FACEBOOK_PAGE_ID") and _env("FACEBOOK_PAGE_ACCESS_TOKEN"))
    if service == "instagram":
        return bool(_env("INSTAGRAM_USER_ID") and _env("INSTAGRAM_ACCESS_TOKEN"))
    if service == "tiktok":
        return bool(_env("TIKTOK_ACCESS_TOKEN"))
    return False


def _success_message(provider, record):
    if provider == "canva":
        return "Canva is connected."
    if provider == "youtube":
        label = record.get("account_label")
        return f"YouTube is connected as {label}." if label else "YouTube is connected."
    if provider == "tiktok":
        label = record.get("account_label")
        return f"TikTok is connected as {label}." if label else "TikTok is connected."
    page = record.get("page_name") or "the Page"
    if record.get("page_access_token") and record.get("instagram_user_id"):
        return f"Facebook Page {page} is connected. Instagram is connected too."
    if record.get("page_access_token"):
        return f"Facebook Page {page} is connected. No Instagram professional account is linked to that Page."
    return "Meta login finished, but no Facebook Page was returned. ADA needs a Page you manage."


_manager = None


def manager():
    global _manager
    if _manager is None:
        _load_env_files()
        _manager = ConnectionManager()
    return _manager


def set_manager(value):
    global _manager
    _manager = value


def canva_access_token():
    return manager().canva_access_token()


def youtube_access_token():
    return manager().youtube_access_token()


def tiktok_access_token():
    return manager().tiktok_access_token()


def facebook_credentials():
    return manager().facebook_credentials()


def instagram_credentials():
    return manager().instagram_credentials()


def connection_summary():
    return manager().describe()
