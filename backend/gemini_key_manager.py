import asyncio
import os
import time

from google import genai


class GeminiKeyManager:
    def __init__(self, http_options=None, cooldown_seconds=90):
        self.http_options = http_options or {}
        self.cooldown_seconds = cooldown_seconds
        self._lock = asyncio.Lock()
        self._cursor = 0
        self._entries = []

        seen = set()
        for key in self._load_keys():
            if key in seen:
                continue
            seen.add(key)
            self._entries.append({
                "slot": len(self._entries) + 1,
                "key": key,
                "client": genai.Client(http_options=self.http_options, api_key=key),
                "blocked_until": 0.0,
                "failures": 0,
            })

    def _load_keys(self):
        keys = []

        primary = os.getenv("GEMINI_API_KEY", "").strip()
        if primary:
            keys.append(primary)

        fallbacks = os.getenv("GEMINI_API_KEY_FALLBACKS", "")
        if fallbacks:
            keys.extend(key.strip() for key in fallbacks.split(",") if key.strip())

        indexed = []
        for env_name, value in os.environ.items():
            if env_name.startswith("GEMINI_API_KEY_") and env_name != "GEMINI_API_KEY_FALLBACKS":
                suffix = env_name.removeprefix("GEMINI_API_KEY_")
                if suffix.isdigit() and value.strip():
                    indexed.append((int(suffix), value.strip()))

        indexed.sort(key=lambda item: item[0])
        keys.extend(value for _, value in indexed)
        return keys

    def _is_available(self, entry):
        return entry["blocked_until"] <= time.time()

    @property
    def has_configured_keys(self):
        return bool(self._entries)

    @property
    def primary_client(self):
        if not self._entries:
            return None
        return self._entries[0]["client"]

    async def acquire(self):
        async with self._lock:
            if not self._entries:
                raise RuntimeError(
                    "No Gemini API keys configured. Set GEMINI_API_KEY and optionally "
                    "GEMINI_API_KEY_FALLBACKS or GEMINI_API_KEY_<n>."
                )

            now = time.time()
            available = [entry for entry in self._entries if entry["blocked_until"] <= now]

            if not available:
                soonest = min(entry["blocked_until"] for entry in self._entries)
                wait_time = max(0.0, soonest - now)
                raise RuntimeError(f"All Gemini API keys are temporarily cooling down. Retry in {wait_time:.1f}s.")

            start_index = self._cursor % len(self._entries)
            for offset in range(len(self._entries)):
                entry = self._entries[(start_index + offset) % len(self._entries)]
                if self._is_available(entry):
                    self._cursor = (start_index + offset + 1) % len(self._entries)
                    return entry

            raise RuntimeError("No Gemini API key is currently available.")

    async def release_success(self, entry):
        async with self._lock:
            entry["failures"] = 0
            entry["blocked_until"] = 0.0

    async def report_failure(self, entry, error):
        async with self._lock:
            entry["failures"] += 1
            if self.is_quota_error(error):
                entry["blocked_until"] = time.time() + self.cooldown_seconds
            elif self.is_retryable_error(error):
                entry["blocked_until"] = time.time() + min(10, 2 * entry["failures"])

    @staticmethod
    def describe_error(error):
        parts = []
        for attr in ("message", "details"):
            value = getattr(error, attr, None)
            if value:
                parts.append(str(value))
        parts.append(str(error))
        return " ".join(part for part in parts if part).strip()

    @classmethod
    def is_quota_error(cls, error):
        message = cls.describe_error(error).lower()
        status_code = getattr(error, "status_code", None) or getattr(error, "code", None)
        return status_code == 429 or any(token in message for token in [
            "resource_exhausted",
            "quota",
            "rate limit",
            "too many requests",
            "429",
        ])

    @classmethod
    def is_retryable_error(cls, error):
        message = cls.describe_error(error).lower()
        status_code = getattr(error, "status_code", None) or getattr(error, "code", None)
        return cls.is_quota_error(error) or status_code in {500, 502, 503, 504} or any(token in message for token in [
            "temporarily unavailable",
            "deadline exceeded",
            "timed out",
            "internal",
            "unavailable",
        ])
