"""Read-only pipeline-state summary for the frontend (app/static/) —
inspects the filesystem to report what's staged/built/run for a project,
without rendering or running anything itself. Lets the UI show accurate
progress (which nights are staged, whether masters exist, whether a
result.fit exists) without the frontend having to track state on its own
or guess from prior API responses.
"""

from __future__ import annotations

from pathlib import Path

from . import config

_FIT_SUFFIXES = ("*.fit", "*.fits")


def _count_fits(dir_path: Path) -> int:
    if not dir_path.is_dir():
        return 0
    return sum(1 for pat in _FIT_SUFFIXES for _ in dir_path.glob(pat))


def _master_exists(path_no_ext: Path) -> bool:
    return path_no_ext.with_suffix(".fit").exists() or path_no_ext.exists()


def project_status(project: Path) -> dict:
    raw = project / "raw"
    process = project / "process"
    meta = config.read_project_meta(project)
    night_labels = meta.get("night_labels", {})
    # Actual `-out=` filename from the most recent single-night stack for
    # this night, recorded by main.py's run_stack() right before the job
    # starts (see app/ssf.py's output_basename() — Project Name + total
    # integration time, not always literally "result.fit" anymore).
    # Falls back to "result.fit" for a project stacked before this existed.
    night_result_filenames = meta.get("night_result_filenames", {})
    # Per-night calibration alignment (see CalibrationOverridesRequest) -
    # a night absent from either dict just uses its normal default
    # (shared master_dark / that night's own master_flat).
    night_dark_overrides = meta.get("night_dark_overrides", {})
    night_flat_overrides = meta.get("night_flat_overrides", {})
    # Filter code staged for this night (see NightSource.filter), None for
    # an unfiltered/OSC session or a project staged before this existed.
    night_filters = meta.get("night_filters", {})

    nights = []
    nights_dir = raw / "nights"
    if nights_dir.is_dir():
        for night_dir in sorted(p for p in nights_dir.iterdir() if p.is_dir()):
            name = night_dir.name
            night_process = process / "nights" / name
            # A single-night stack's result lands right in that night's
            # own calibrate workspace (app/ssf.py) — see module
            # docstring's raw/process layout. Paths returned are relative
            # to the project dir, ready to pass straight to
            # GET /projects/{name}/preview?path=... .
            result_filename = night_result_filenames.get(name, "result.fit")
            result_rel = f"process/nights/{name}/lights/{result_filename}"
            nights.append(
                {
                    "name": name,
                    # What the source capture folder was actually called
                    # (e.g. "Night 1") — for display only; every internal
                    # path/API call still uses `name`. Falls back to
                    # `name` itself for projects staged before this was
                    # tracked (app/staging.py).
                    "label": night_labels.get(name, name),
                    "light_count": _count_fits(night_dir / "lights"),
                    "flat_count": _count_fits(night_dir / "flats"),
                    "master_flat_built": _master_exists(night_process / "master_flat"),
                    "result_path": result_rel if (project / result_rel).exists() else None,
                    "sample_light_path": _sample_light_path(night_dir / "lights", project),
                    "dark_override": night_dark_overrides.get(name),
                    "flat_override": night_flat_overrides.get(name),
                    "filter": night_filters.get(name),
                }
            )

    # A multi-night stack's merged result lands in the shared
    # process/lights/_merged/ workspace (see app/ssf.py).
    merged_filename = meta.get("merged_result_filename", "result.fit")
    merged_rel = f"process/lights/_merged/{merged_filename}"
    return {
        "biases_count": _count_fits(raw / "biases"),
        "darks_count": _count_fits(raw / "darks"),
        "master_bias_built": _master_exists(process / "master_bias"),
        "master_dark_built": _master_exists(process / "master_dark"),
        "nights": nights,
        "merged_result_path": merged_rel if (project / merged_rel).exists() else None,
        # Defaults True (matches StackLightsRequest.is_osc's own default)
        # for projects staged before this setting existed.
        "is_osc": meta.get("is_osc", True),
        # Starting path for this project's folder pickers, relative to
        # CAPTURES_DIR - None for projects created before this existed
        # (pickers just fall back to browsing from the captures root).
        "root_dir": meta.get("root_dir"),
    }


def _sample_light_path(lights_dir: Path, project: Path) -> str | None:
    """First light frame's path relative to the project dir, for a quick
    'does this night look right' preview before running any analysis.
    """
    if not lights_dir.is_dir():
        return None
    for pat in _FIT_SUFFIXES:
        for p in sorted(lights_dir.glob(pat)):
            return str(p.relative_to(project))
    return None
