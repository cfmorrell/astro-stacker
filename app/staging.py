"""Symlinks raw capture frames from CAPTURES_DIR into a project's raw/ tree.

Replaces manual `mkdir` + scripts/stage_captures.sh invocation. Source
folder names (e.g. "Night 1", with a space) never need to match any
convention — the caller picks the internal night name that lands on disk
(raw/nights/<name>/...), decoupling our layout from whatever the telescope
control software happened to call things (per Chris: "we should remain
flexible on naming conventions").

Symlinking (not copying) is deliberate and matches scripts/stage_captures.sh:
CAPTURES_DIR stays read-only always (Handoff.md gotcha #2 — Siril can
never `cd` into it directly), and cheap symlinks avoid duplicating
potentially large FITS files on disk.
"""

from __future__ import annotations

from pathlib import Path

from . import config
from .models import StageProjectRequest

_FIT_SUFFIXES = {".fit", ".fits"}


def _resolve_capture_dir(rel: str) -> Path:
    """Resolve a path relative to CAPTURES_DIR, rejecting anything that
    would escape it. Pydantic gives us a plain string straight from an
    HTTP request body, so this has to be defensive: an absolute path or a
    '..' component must not be able to read outside CAPTURES_DIR.
    """
    rel_path = Path(rel)
    if rel_path.is_absolute():
        # Path.__truediv__ discards the left operand entirely when the
        # right one is absolute (Path("/a") / "/b" == Path("/b")) — so this
        # must be rejected *before* joining, not caught after the fact.
        raise ValueError(f"lights/flats/biases/darks dir must be relative to captures: {rel!r}")
    if ".." in rel_path.parts:
        raise ValueError(f"path must not contain '..': {rel!r}")

    captures_root = config.CAPTURES_DIR.resolve()
    candidate = (config.CAPTURES_DIR / rel_path).resolve()
    if candidate != captures_root and captures_root not in candidate.parents:
        raise ValueError(f"path escapes CAPTURES_DIR: {rel!r}")
    if not candidate.is_dir():
        raise ValueError(f"source directory not found under captures: {rel!r}")
    return candidate


def _link_dir(source: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    for src in sorted(source.iterdir()):
        if src.suffix.lower() not in _FIT_SUFFIXES:
            continue
        link = dest / src.name
        link.unlink(missing_ok=True)
        link.symlink_to(src.resolve())
        count += 1
    return count


def stage_project(project: Path, req: StageProjectRequest) -> dict:
    """Symlink biases/darks/per-night lights+flats into project/raw/ per
    req, creating the project directory if needed. Returns a summary of
    how many files landed in each destination.
    """
    project.mkdir(parents=True, exist_ok=True)
    summary: dict = {}

    if req.biases_dir is not None:
        source = _resolve_capture_dir(req.biases_dir)
        summary["biases"] = _link_dir(source, project / "raw" / "biases")

    if req.darks_dir is not None:
        source = _resolve_capture_dir(req.darks_dir)
        summary["darks"] = _link_dir(source, project / "raw" / "darks")

    nights_summary: dict = {}
    meta = config.read_project_meta(project)
    night_labels: dict = meta.setdefault("night_labels", {})
    for night in req.nights:
        if not night.name or "/" in night.name or night.name in (".", ".."):
            raise ValueError(f"invalid night name: {night.name!r}")
        lights_source = _resolve_capture_dir(night.lights_dir)
        flats_source = _resolve_capture_dir(night.flats_dir)
        night_root = project / "raw" / "nights" / night.name
        nights_summary[night.name] = {
            "lights": _link_dir(lights_source, night_root / "lights"),
            "flats": _link_dir(flats_source, night_root / "flats"),
        }
        # The frontend never asks for a night name (auto-numbered night1,
        # night2, ...) but Chris wants the checkboxes elsewhere in the UI
        # to show whatever the SOURCE folder was actually called (e.g. his
        # real capture folders are literally "Night 1"/"Night 2") — so
        # remember that original folder name here, keyed by our internal
        # name, purely for display.
        night_labels[night.name] = Path(night.lights_dir).parent.name or night.name
    if nights_summary:
        summary["nights"] = nights_summary

    if req.is_osc is not None:
        meta["is_osc"] = req.is_osc
    config.write_project_meta(project, meta)

    return summary
