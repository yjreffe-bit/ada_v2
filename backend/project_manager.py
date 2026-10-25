import inspect
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import uuid
from pathlib import Path


def default_projects_dir():
    """Per-user project data, outside the repo so OneDrive cannot lock it.

    Windows: %LOCALAPPDATA%\\ADA\\projects
    macOS: ~/Library/Application Support/ADA/projects
    Linux: $XDG_DATA_HOME/ADA/projects or ~/.local/share/ADA/projects
    """
    if sys.platform == "win32":
        root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        root = str(Path.home() / "Library" / "Application Support")
    else:
        root = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(root) / "ADA" / "projects"


def remove_tree(path):
    """Delete a tree, clearing the read-only bit and retrying once.

    OneDrive placeholders and Windows read-only files raise PermissionError
    (WinError 5) from shutil.rmtree. The retry handles the read-only case.
    Callers still have to catch a second failure.
    """
    def retry(func, target, _exc):
        try:
            os.chmod(target, stat.S_IWUSR | stat.S_IRUSR | stat.S_IXUSR)
        except OSError:
            pass
        func(target)

    if "onexc" in inspect.signature(shutil.rmtree).parameters:
        shutil.rmtree(path, onexc=retry)
    else:
        def onerror(func, target, exc_info):
            retry(func, target, exc_info[1] if exc_info else None)
        shutil.rmtree(path, onerror=onerror)


def _same_path(left, right):
    try:
        return Path(left).resolve() == Path(right).resolve()
    except OSError:
        return os.path.normcase(str(left)) == os.path.normcase(str(right))


def _copy_tree(src, dest):
    """Copy what we can. A locked OneDrive file is logged and skipped."""
    copied = 0
    for root, _dirs, files in os.walk(src):
        target_root = dest / Path(root).relative_to(src)
        try:
            target_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            print(f"[ProjectManager] Skipped directory {target_root}: {exc}")
            continue
        for name in files:
            source = Path(root) / name
            target = target_root / name
            if target.exists():
                continue
            try:
                shutil.copy2(source, target)
                copied += 1
            except OSError as exc:
                print(f"[ProjectManager] Skipped {source}: {exc}")
    return copied


class ProjectManager:
    def __init__(self, workspace_root: str, projects_dir=None):
        self.workspace_root = Path(workspace_root)
        self.projects_dir = self._choose_projects_dir(projects_dir)
        self.current_project = "temp"
        print(f"[ProjectManager] Projects directory: {self.projects_dir}")
        self._migrate_legacy_projects()
        self._activate_temp()

    def _choose_projects_dir(self, projects_dir):
        legacy = self.workspace_root / "projects"
        if projects_dir:
            chosen = Path(projects_dir)
        elif os.environ.get("ADA_PROJECTS_DIR"):
            chosen = Path(os.environ["ADA_PROJECTS_DIR"])
        else:
            chosen = default_projects_dir()
        try:
            chosen.mkdir(parents=True, exist_ok=True)
            return chosen
        except OSError as exc:
            print(f"[ProjectManager] Cannot use {chosen} ({exc}).")
        try:
            legacy.mkdir(parents=True, exist_ok=True)
            print(f"[ProjectManager] Using the repository projects folder: {legacy}")
            return legacy
        except OSError as exc:
            fallback = Path(tempfile.mkdtemp(prefix="ada-projects-"))
            print(f"[ProjectManager] Project folders are unavailable ({exc}). Using {fallback}.")
            return fallback

    def _migrate_legacy_projects(self):
        """Copy named projects out of <repo>/projects. Temp is not copied or deleted."""
        legacy = self.workspace_root / "projects"
        if not legacy.is_dir() or _same_path(legacy, self.projects_dir):
            return
        try:
            children = list(legacy.iterdir())
        except OSError as exc:
            print(f"[ProjectManager] Could not read {legacy}: {exc}")
            return
        for child in children:
            if not child.is_dir():
                continue
            if child.name == "temp" or child.name.startswith("temp-"):
                continue
            dest = self.projects_dir / child.name
            if dest.exists():
                continue
            print(f"[ProjectManager] Copying project '{child.name}' to {dest}")
            try:
                _copy_tree(child, dest)
            except Exception as exc:
                print(f"[ProjectManager] Could not copy '{child.name}': {exc}")

    def _safe_name(self, name):
        return "".join([c for c in name if c.isalnum() or c in (' ', '-', '_')]).strip()

    def _activate_temp(self):
        """Clear temp. A failed delete must not stop startup."""
        name = "temp"
        temp_path = self.projects_dir / "temp"
        if temp_path.exists():
            print("[ProjectManager] Clearing temp project...")
            try:
                remove_tree(temp_path)
            except Exception as exc:
                name = f"temp-{uuid.uuid4().hex[:8]}"
                print(f"[ProjectManager] Temp cleanup failed ({exc}). Using a fresh directory '{name}'.")
        if not self._ensure_project(name):
            name = f"temp-{uuid.uuid4().hex[:8]}"
            print(f"[ProjectManager] Could not prepare temp. Trying '{name}'.")
            if not self._ensure_project(name):
                print("[ProjectManager] Temp project is unavailable. Startup will continue.")
                self.current_project = name
                return
        self._clear_stale_temps(keep=name)

    def _ensure_project(self, name):
        safe = self._safe_name(name)
        if not safe:
            return False
        project_path = self.projects_dir / safe
        try:
            if not project_path.exists():
                project_path.mkdir()
                (project_path / "cad").mkdir()
                (project_path / "browser").mkdir()
                (project_path / "video").mkdir()
                print(f"[ProjectManager] Created project: {safe}")
            elif not project_path.is_dir():
                return False
            self.current_project = safe
            return True
        except OSError as exc:
            print(f"[ProjectManager] Could not create project '{safe}': {exc}")
            return False

    def _clear_stale_temps(self, keep):
        try:
            children = list(self.projects_dir.iterdir())
        except OSError as exc:
            print(f"[ProjectManager] Could not list temp directories: {exc}")
            return
        for child in children:
            if not child.is_dir() or child.name == keep:
                continue
            if child.name == "temp" or child.name.startswith("temp-"):
                try:
                    remove_tree(child)
                except Exception as exc:
                    print(f"[ProjectManager] Left leftover '{child.name}' in place: {exc}")

    def create_project(self, name: str):
        """Creates a new project directory with subfolders."""
        safe_name = self._safe_name(name)
        project_path = self.projects_dir / safe_name
        
        if not project_path.exists():
            project_path.mkdir()
            (project_path / "cad").mkdir()
            (project_path / "browser").mkdir()
            (project_path / "video").mkdir()
            print(f"[ProjectManager] Created project: {safe_name}")
            return True, f"Project '{safe_name}' created."
        return False, f"Project '{safe_name}' already exists."

    def switch_project(self, name: str):
        """Switches the active project context."""
        safe_name = "".join([c for c in name if c.isalnum() or c in (' ', '-', '_')]).strip()
        project_path = self.projects_dir / safe_name
        
        if project_path.exists():
            self.current_project = safe_name
            print(f"[ProjectManager] Switched to project: {safe_name}")
            return True, f"Switched to project '{safe_name}'."
        return False, f"Project '{safe_name}' does not exist."

    def list_projects(self):
        """Returns a list of available projects."""
        return [d.name for d in self.projects_dir.iterdir() if d.is_dir()]

    def get_current_project_path(self):
        return self.projects_dir / self.current_project

    def log_chat(self, sender: str, text: str):
        """Appends a chat message to the current project's history."""
        log_file = self.get_current_project_path() / "chat_history.jsonl"
        entry = {
            "timestamp": time.time(),
            "sender": sender,
            "text": text
        }
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    def save_cad_artifact(self, source_path: str, prompt: str):
        """Copies a generated CAD file to the project's 'cad' folder."""
        if not os.path.exists(source_path):
            print(f"[ProjectManager] [ERR] Source file not found: {source_path}")
            return None

        # Create a filename based on timestamp and prompt
        timestamp = int(time.time())
        # Brief sanitization of prompt for filename
        safe_prompt = "".join([c for c in prompt if c.isalnum() or c in (' ', '-', '_')])[:30].strip().replace(" ", "_")
        filename = f"{timestamp}_{safe_prompt}.stl"
        
        dest_path = self.get_current_project_path() / "cad" / filename
        
        try:
            shutil.copy2(source_path, dest_path)
            print(f"[ProjectManager] Saved CAD artifact to: {dest_path}")
            return str(dest_path)
        except Exception as e:
            print(f"[ProjectManager] [ERR] Failed to save artifact: {e}")
            return None

    def save_video_artifact(self, source_path: str, title: str):
        """Copies a generated video file to the project's 'video' folder."""
        if not os.path.exists(source_path):
            print(f"[ProjectManager] [ERR] Video source file not found: {source_path}")
            return None

        timestamp = int(time.time())
        safe_title = "".join([c for c in title if c.isalnum() or c in (' ', '-', '_')])[:40].strip().replace(" ", "_")
        ext = Path(source_path).suffix or ".mp4"
        filename = f"{timestamp}_{safe_title or 'content_video'}{ext}"
        dest_path = self.get_current_project_path() / "video" / filename

        try:
            shutil.copy2(source_path, dest_path)
            print(f"[ProjectManager] Saved video artifact to: {dest_path}")
            return str(dest_path)
        except Exception as e:
            print(f"[ProjectManager] [ERR] Failed to save video artifact: {e}")
            return None

    def get_project_context(self, max_file_size: int = 10000) -> str:
        """
        Gathers context about the current project for the AI.
        Lists all files and reads text file contents (up to max_file_size bytes).
        """
        project_path = self.get_current_project_path()
        if not project_path.exists():
            return f"Project '{self.current_project}' does not exist."

        context_lines = [f"=== Project Context: '{self.current_project}' ==="]
        context_lines.append(f"Project directory: {project_path}")
        context_lines.append("")

        # List all files recursively
        all_files = []
        for root, dirs, files in os.walk(project_path):
            for f in files:
                rel_path = os.path.relpath(os.path.join(root, f), project_path)
                all_files.append(rel_path)

        if not all_files:
            context_lines.append("(No files in project yet)")
        else:
            context_lines.append(f"Files ({len(all_files)} total):")
            for f in all_files:
                context_lines.append(f"  - {f}")

        context_lines.append("")

        # Read text files (skip binary and large files)
        text_extensions = {'.txt', '.py', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.html', '.css', '.jsonl'}
        for rel_path in all_files:
            ext = os.path.splitext(rel_path)[1].lower()
            if ext not in text_extensions:
                continue

            full_path = project_path / rel_path
            try:
                file_size = full_path.stat().st_size
                if file_size > max_file_size:
                    context_lines.append(f"--- {rel_path} (too large: {file_size} bytes, skipped) ---")
                    continue

                with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                context_lines.append(f"--- {rel_path} ---")
                context_lines.append(content)
                context_lines.append("")
            except Exception as e:
                context_lines.append(f"--- {rel_path} (error reading: {e}) ---")

        return "\n".join(context_lines)

    def get_recent_chat_history(self, limit: int = 10):
        """Returns the last 'limit' chat messages from history."""
        log_file = self.get_current_project_path() / "chat_history.jsonl"
        if not log_file.exists():
            return []
            
        try:
            with open(log_file, "r", encoding="utf-8") as f:
                lines = f.readlines()
                
            # Parse last N lines
            history = []
            for line in lines[-limit:]:
                try:
                    entry = json.loads(line)
                    history.append(entry)
                except json.JSONDecodeError:
                    continue
            return history
        except Exception as e:
            print(f"[ProjectManager] [ERR] Failed to read chat history: {e}")
            return []

