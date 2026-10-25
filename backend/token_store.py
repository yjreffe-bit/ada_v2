"""Local OAuth token storage.

Tokens go to the OS keyring when the optional ``keyring`` package can store
them. Otherwise they go to a file outside the repository, mode 0600.
Nothing in this module prints token values.
"""

import json
import os
import sys
import tempfile
from pathlib import Path


SERVICE = "ADA"
USERNAME = "oauth-tokens"


def default_token_path():
    """Return the per-user token file. This path is outside the repo."""
    if sys.platform == "win32":
        root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        root = str(Path.home() / "Library" / "Application Support")
    else:
        root = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(root) / "ADA" / "oauth_tokens.json"


def _try_keyring():
    try:
        import keyring
    except Exception:
        return None
    return keyring


class TokenStore:
    def __init__(self, path=None, keyring_module=None, prefer_keyring=True):
        self.path = Path(path) if path else default_token_path()
        self._keyring = keyring_module if keyring_module is not None else (_try_keyring() if prefer_keyring else None)
        self._prefer_keyring = prefer_keyring and self._keyring is not None

    def load(self):
        if self._prefer_keyring:
            raw = self._keyring_get()
            if raw:
                return _parse(raw)
        return _parse(self._read_file())

    def save(self, data):
        payload = json.dumps(data or {})
        if not data:
            self.clear()
            return
        if self._prefer_keyring and self._keyring_set(payload):
            self._remove_file()
            return
        self._write_file(payload)

    def clear(self):
        if self._keyring is not None:
            try:
                self._keyring.delete_password(SERVICE, USERNAME)
            except Exception:
                pass
        self._remove_file()

    def _keyring_get(self):
        try:
            return self._keyring.get_password(SERVICE, USERNAME)
        except Exception:
            self._prefer_keyring = False
            return None

    def _keyring_set(self, payload):
        try:
            self._keyring.set_password(SERVICE, USERNAME, payload)
            return True
        except Exception:
            self._prefer_keyring = False
            return False

    def _read_file(self):
        try:
            return self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""
        except Exception:
            return ""

    def _write_file(self, payload):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.path.parent, 0o700)
        except OSError:
            pass
        descriptor, temporary = tempfile.mkstemp(dir=str(self.path.parent), prefix=".oauth-", suffix=".tmp")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)

    def _remove_file(self):
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def _parse(raw):
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
