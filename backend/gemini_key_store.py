"""Gemini API keys for ADA.

Keys live in the same local store as Connect tokens: the OS keyring when it
works, otherwise a private file outside the repo. They are never written into
settings.json, source, or logs.
"""

from mobile_behavior import KeyRotator, mask_key

GEMINI_KEY = "gemini_api_keys"


class GeminiKeyStore:
    def __init__(self, store, cooldown_seconds=90, clock=None, env_keys=None):
        self.store = store
        self.cooldown_seconds = cooldown_seconds
        self.clock = clock
        self._env_keys = [key.strip() for key in (env_keys or []) if key and key.strip()]
        self._rotator = None
        self._keyring_active = bool(getattr(store, "_prefer_keyring", False))
        self.reload()

    def reload(self):
        saved = self._saved_keys()
        combined = []
        seen = set()
        for key in saved + self._env_keys:
            if key in seen:
                continue
            seen.add(key)
            combined.append(key)
        previous = {entry["key"]: entry["blocked_until"] for entry in (self._rotator._entries if self._rotator else [])}
        self._rotator = KeyRotator(combined, self.cooldown_seconds, clock=self.clock)
        for entry in self._rotator._entries:
            if entry["key"] in previous:
                entry["blocked_until"] = previous[entry["key"]]
        self._saved_set = set(saved)

    def _saved_keys(self):
        data = self.store.load() or {}
        rows = data.get(GEMINI_KEY) or []
        keys = []
        for row in rows:
            if isinstance(row, str):
                key = row.strip()
            elif isinstance(row, dict):
                key = str(row.get("key") or "").strip()
            else:
                key = ""
            if key:
                keys.append(key)
        return keys

    def add(self, key):
        cleaned = (key or "").strip()
        if len(cleaned) < 10:
            return "That key looks too short."
        data = self.store.load() or {}
        rows = list(data.get(GEMINI_KEY) or [])
        existing = []
        for row in rows:
            if isinstance(row, dict):
                existing.append(row.get("key"))
            else:
                existing.append(row)
        if cleaned not in existing:
            rows.append({"key": cleaned})
            data[GEMINI_KEY] = rows
            self.store.save(data)
        self.reload()
        return ""

    def delete_slot(self, slot):
        """Delete a saved key by the public slot number. Env-only keys stay."""
        try:
            slot = int(slot)
        except (TypeError, ValueError):
            return False
        rows = self._rotator.public_rows()
        target = next((row for row in self._rotator._entries if row["slot"] == slot), None)
        if not target:
            return False
        if target["key"] not in self._saved_set:
            return False
        data = self.store.load() or {}
        kept = []
        for row in data.get(GEMINI_KEY) or []:
            value = row.get("key") if isinstance(row, dict) else row
            if value != target["key"]:
                kept.append(row)
        data[GEMINI_KEY] = kept
        self.store.save(data)
        self.reload()
        return True

    def acquire(self):
        return self._rotator.acquire()

    def cool(self, slot):
        self._rotator.cool(slot)

    def public_view(self):
        rows = []
        for row in self._rotator.public_rows():
            entry = next(item for item in self._rotator._entries if item["slot"] == row["slot"])
            source = "saved" if entry["key"] in self._saved_set else "env"
            detail = row["detail"]
            if source == "env" and row["state"] == "ready":
                detail = "Ready"
            rows.append({
                **row,
                "source": source,
                "deletable": source == "saved",
            })
        return {
            "keys": rows,
            "cooldown_seconds": self._rotator.cooldown_seconds,
            "keyring": self._keyring_active,
            "count": len(rows),
        }

    def mask(self, key):
        return mask_key(key)
