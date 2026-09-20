"""Paths and environment-derived settings.

See Handoff.md "Environment / paths" for the mount layout this assumes:
- SIRIL_BIN: the AppImage's own launcher (AppRun). Must be invoked as
  `SIRIL_BIN siril-cli ...` — SIRIL_BIN alone launches the GUI and fails
  headless (see Handoff.md gotcha #1). Never bake "siril-cli" into this
  env var string; keep it a separate argv element.
- DATA_DIR: bind-mounted, NOT in git. Holds per-project working dirs.
- CAPTURES_DIR: bind-mounted read-only. Raw camera output. Siril can never
  `cd` into this directly (gotcha #2) — projects stage symlinks from here
  into DATA_DIR/projects/<name>/raw/ via scripts/stage_captures.sh first.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

SIRIL_BIN = os.environ.get("SIRIL_BIN", "/opt/siril/AppRun")
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CAPTURES_DIR = Path(os.environ.get("CAPTURES_DIR", "/captures"))
PROJECTS_DIR = DATA_DIR / "projects"


def project_dir(name: str) -> Path:
    """Resolve a project name to its working directory, rejecting anything
    that could escape PROJECTS_DIR (no path separators, no '.'/'..').
    """
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise ValueError(f"invalid project name: {name!r}")
    return PROJECTS_DIR / name


def read_project_meta(project: Path) -> dict:
    """Small per-project settings that don't fit anywhere on disk already
    (is_osc, and each internal night name's original source-folder label
    for display — see app/staging.py). Missing/corrupt file just means
    "no settings recorded yet", not an error.
    """
    meta_path = project / "meta.json"
    if not meta_path.is_file():
        return {}
    try:
        return json.loads(meta_path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def write_project_meta(project: Path, meta: dict) -> None:
    (project / "meta.json").write_text(json.dumps(meta, indent=2))
