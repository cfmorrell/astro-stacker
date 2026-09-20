"""Read-only pipeline-state summary for the frontend (app/static/) —
inspects the filesystem to report what's staged/built/run for a project,
without rendering or running anything itself. Lets the UI show accurate
progress (which nights are staged, whether masters exist, whether a
result.fit exists) without the frontend having to track state on its own
or guess from prior API responses.
"""

from __future__ import annotations

from pathlib import Path

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
            result_rel = f"process/nights/{name}/lights/result.fit"
            nights.append(
                {
                    "name": name,
                    "light_count": _count_fits(night_dir / "lights"),
                    "flat_count": _count_fits(night_dir / "flats"),
                    "master_flat_built": _master_exists(night_process / "master_flat"),
                    "result_path": result_rel if (project / result_rel).exists() else None,
                    "sample_light_path": _sample_light_path(night_dir / "lights", project),
                }
            )

    # A multi-night stack's merged result lands in the shared
    # process/lights/_merged/ workspace (see app/ssf.py).
    merged_rel = "process/lights/_merged/result.fit"
    return {
        "biases_count": _count_fits(raw / "biases"),
        "darks_count": _count_fits(raw / "darks"),
        "master_bias_built": _master_exists(process / "master_bias"),
        "master_dark_built": _master_exists(process / "master_dark"),
        "nights": nights,
        "merged_result_path": merged_rel if (project / merged_rel).exists() else None,
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
