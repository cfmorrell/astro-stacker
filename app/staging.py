"""Symlinks raw capture frames from CAPTURES_DIR into a project's raw/ tree.

Source folder names (e.g. "Night 1", with a space) never need to match any
convention — the caller picks the internal night name that lands on disk
(raw/nights/<name>/...), decoupling our layout from whatever the telescope
control software happened to call things (per Chris: "we should remain
flexible on naming conventions").

Symlinking (not copying) is deliberate: CAPTURES_DIR stays read-only
always (Handoff.md gotcha #2 — Siril can never `cd` into it directly),
and cheap symlinks avoid duplicating potentially large FITS files on disk.
"""

from __future__ import annotations

from pathlib import Path

from . import config, frameinfo
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


def _link_dir(source: Path, dest: Path, filter_code: str | None = None) -> int:
    """Symlink every FITS file from source into dest, or (when filter_code
    is given) only those whose filename matches that filter — see
    NightSource's docstring. dest is wiped of stale FITS symlinks first
    (not just added to) so re-staging with a different/no filter can't
    leave a previous filter's files behind mixed in with the new ones.
    """
    dest.mkdir(parents=True, exist_ok=True)
    for existing in dest.iterdir():
        if existing.is_symlink() and existing.suffix.lower() in _FIT_SUFFIXES:
            existing.unlink()
    count = 0
    for src in sorted(source.iterdir()):
        if src.suffix.lower() not in _FIT_SUFFIXES:
            continue
        if filter_code is not None and frameinfo.parse_filter(src.name) != filter_code.upper():
            continue
        link = dest / src.name
        link.unlink(missing_ok=True)
        link.symlink_to(src.resolve())
        count += 1
    if filter_code is not None and count == 0:
        raise ValueError(
            f"no files in {str(source)!r} matched filter {filter_code!r} — "
            "check the filter code against what's actually in this folder"
        )
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
            "lights": _link_dir(lights_source, night_root / "lights", night.filter),
            "flats": _link_dir(flats_source, night_root / "flats", night.filter),
        }
        # The frontend never asks for a night name (auto-numbered night1,
        # night2, ...) but Chris wants the checkboxes elsewhere in the UI
        # to show whatever the SOURCE folder was actually called (e.g. his
        # real capture folders are literally "Night 1"/"Night 2") — so
        # remember that original folder name here, keyed by our internal
        # name, purely for display. A filter gets appended so three
        # sessions built from the same physical folder (one per filter)
        # don't all show up with the identical label.
        base_label = Path(night.lights_dir).parent.name or night.name
        night_labels[night.name] = f"{base_label} ({night.filter})" if night.filter else base_label
        # Tracked separately (structured, not just baked into the display
        # label) so the frontend can warn if nights with DIFFERENT filters
        # ever get selected together for a merge+stack - combining two
        # different filters' lights into one stack is never correct.
        meta.setdefault("night_filters", {})[night.name] = night.filter
    if nights_summary:
        summary["nights"] = nights_summary

    if req.is_osc is not None:
        meta["is_osc"] = req.is_osc
    if req.root_dir is not None:
        # Validated the same way as biases_dir/darks_dir (must actually
        # exist under CAPTURES_DIR) even though nothing is linked from it
        # directly - it's purely a remembered starting path for pickers.
        _resolve_capture_dir(req.root_dir)
        meta["root_dir"] = req.root_dir
    config.write_project_meta(project, meta)

    return summary
