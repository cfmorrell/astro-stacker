"""Paths and environment-derived settings.

See Handoff.md "Environment / paths" for the mount layout this assumes:
- SIRIL_BIN: the AppImage's own launcher (AppRun). Must be invoked as
  `SIRIL_BIN siril-cli ...` — SIRIL_BIN alone launches the GUI and fails
  headless (see Handoff.md gotcha #1). Never bake "siril-cli" into this
  env var string; keep it a separate argv element.
- DATA_DIR: bind-mounted, NOT in git. Holds per-project working dirs.
- CAPTURES_DIR: bind-mounted read-only. Raw camera output. Siril can never
  `cd` into this directly (gotcha #2) — projects stage symlinks from here
  into DATA_DIR/projects/<name>/raw/ first (see app/staging.py).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

# Bumped by hand on each release pushed through CI (see
# .github/workflows/docker-publish.yml) - staying under 1.0 deliberately
# until Chris has run this in production long enough to trust it (his
# call, not a date or feature checklist). Shown in the UI header and
# from /health so a running container's version is always visible.
VERSION = "0.6"

SIRIL_BIN = os.environ.get("SIRIL_BIN", "/opt/siril/AppRun")
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CAPTURES_DIR = Path(os.environ.get("CAPTURES_DIR", "/captures"))
PROJECTS_DIR = DATA_DIR / "projects"


_SAFE_PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def project_dir(name: str) -> Path:
    """Resolve a project name to its working directory, rejecting anything
    that could escape PROJECTS_DIR (no path separators, no '.'/'..') AND
    anything outside a safe character set — no spaces or other
    punctuation.

    That second rule earns its keep the hard way: a project's directory
    path gets baked unquoted into every .ssf script's -out=/-dark=/
    -flat=/-bias= arguments (see the templates' own NOTE comments) —
    Siril's script parser tokenizes THOSE specific options on whitespace
    and does not honor quotes around them the way it does for a plain
    `cd "path"` (confirmed the hard way: a real project named "Test OSC
    Project 1" broke on `convert bias -out=/data/projects/Test OSC
    Project 1/...` with "Unknown parameter OSC, aborting." — Siril split
    the path AT THE SPACE and treated "OSC" as a bogus extra argument).
    There is no quoting escape hatch for this in Siril's script language,
    so the only reliable fix is refusing a project name that could ever
    produce a path containing one, not trying to work around it later.
    """
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise ValueError(f"invalid project name: {name!r}")
    if not _SAFE_PROJECT_NAME_RE.match(name):
        raise ValueError(
            f"invalid project name: {name!r} — letters, numbers, hyphens, underscores, and "
            "periods only (no spaces or other punctuation) — Siril's own script language can't "
            "reliably reference a working directory whose path contains one"
        )
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


def read_review_state(project: Path) -> dict | None:
    """The last successful /lights/analyze/run's result (per-frame stats),
    the anomaly_sigma it was flagged with, and the exclude_frames set as
    of the last time the frontend saved it (see write_review_state()) -
    kept in its own file, not folded into meta.json, since this can be a
    real amount of per-frame data for a big project rather than the
    handful of small settings meta.json documents itself as being for.

    This exists purely so the (expensive - real astropy/photutils work
    per frame) analyze result and (cheap, but still a real decision) the
    exclude list survive a page reload or a genuinely new session, not
    just switching projects within one still-open tab (the browser-side
    reviewCache in app.js already covers that case). None if this
    project has never been analyzed, or the file is missing/corrupt -
    "not analyzed yet," not an error.
    """
    path = project / "review_state.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def write_review_state(project: Path, state: dict) -> None:
    (project / "review_state.json").write_text(json.dumps(state, indent=2))


def delete_review_state(project: Path) -> None:
    (project / "review_state.json").unlink(missing_ok=True)
