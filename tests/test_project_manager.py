"""Startup must survive a locked projects/temp, including OneDrive WinError 5."""

import os
import sys
from pathlib import Path

import project_manager
from project_manager import ProjectManager, default_projects_dir, remove_tree


def test_windows_default_is_localappdata(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert default_projects_dir() == tmp_path / "ADA" / "projects"


def test_remove_tree_retries_after_access_denied(tmp_path, monkeypatch):
    browser = tmp_path / "temp" / "browser"
    browser.mkdir(parents=True)
    locked = browser / "lock"
    locked.write_text("x")
    os.chmod(locked, 0o444)
    real_unlink = os.unlink
    calls = {"n": 0}

    def flaky_unlink(path, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise PermissionError(5, "Access is denied", path)
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(os, "unlink", flaky_unlink)
    remove_tree(tmp_path / "temp")
    assert not (tmp_path / "temp").exists()
    assert calls["n"] >= 2


def test_locked_temp_does_not_abort_startup(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    projects = repo / "projects"
    (projects / "temp" / "browser").mkdir(parents=True)
    (projects / "temp" / "browser" / "Cookies").write_text("locked")

    def denied(*_args, **_kwargs):
        raise PermissionError(5, "Access is denied", str(projects / "temp" / "browser"))

    monkeypatch.setattr(project_manager.shutil, "rmtree", denied)
    manager = ProjectManager(repo, projects_dir=projects)
    current = manager.get_current_project_path()
    assert current.is_dir()
    assert manager.current_project != "temp"
    assert manager.current_project.startswith("temp-")
    (current / "browser" / "note.txt").write_text("ok")
    assert (projects / "temp" / "browser" / "Cookies").read_text() == "locked"


def test_env_override_and_legacy_migration(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    legacy = repo / "projects" / "Shop" / "cad"
    legacy.mkdir(parents=True)
    (legacy / "bolt.stl").write_text("solid")
    (repo / "projects" / "temp" / "browser").mkdir(parents=True)
    (repo / "projects" / "temp" / "browser" / "stay.txt").write_text("keep")
    dest = tmp_path / "custom"
    monkeypatch.setenv("ADA_PROJECTS_DIR", str(dest))

    manager = ProjectManager(repo)
    assert manager.projects_dir == dest
    assert (dest / "Shop" / "cad" / "bolt.stl").read_text() == "solid"
    assert (legacy / "bolt.stl").read_text() == "solid"
    assert not (dest / "temp" / "browser" / "stay.txt").exists()
    assert (repo / "projects" / "temp" / "browser" / "stay.txt").read_text() == "keep"
    assert (dest / manager.current_project / "browser").is_dir()


def test_unwritable_data_dir_falls_back_to_repo(tmp_path, monkeypatch):
    blocked = tmp_path / "blocked" / "projects"
    monkeypatch.setenv("ADA_PROJECTS_DIR", str(blocked))
    real_mkdir = Path.mkdir

    def guarded(self, *args, **kwargs):
        if "blocked" in Path(self).parts:
            raise OSError(13, "Permission denied")
        return real_mkdir(self, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", guarded)
    repo = tmp_path / "repo"
    manager = ProjectManager(repo)
    assert manager.projects_dir == repo / "projects"
    assert (repo / "projects" / manager.current_project / "cad").is_dir()
