"""Renders .ssf scripts from the templates/ dir.

Every project uses one universal layout — there is no separate
single-night mode (dropped 2026-09-20; see gotcha "no separate
single-night layout" and _resolve_nights()'s docstring for why: a dual
layout meant an unspecified `nights` could silently assume a raw/lights/
that a multi-night-staged project never had). A "single-night" project is
just one whose `nights` list happens to have one entry.

The command sequence itself — convert -> calibrate -> register -> stack —
is kept identical in structure to the hand-validated script in
Handoff.md ("Validated .ssf script" section), just with the stack method
and master paths parameterized. With 2+ nights, their pp_light sequences
are combined via Siril's `merge` first (Siril requires at least two
inputs to `merge` — confirmed the hard way — so exactly one night skips
this and registers/stacks its own sequence directly instead), following
the pattern in rolandet's osc-multi-night-stacking script (GPLv3,
referenced for structure only, per Handoff.md's licensing note).

Raw/process layout:
    raw/biases, raw/darks                     — shared across the project
    raw/nights/<name>/{lights,flats}          — every night, always
    process/master_bias, process/master_dark  — always shared
    process/nights/<name>/master_flat         — per-night
    process/nights/<name>/lights              — disposable per-run workspace
    process/lights/_merged                    — disposable, 2+ nights only
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from .models import BuildMastersRequest, StackLightsRequest

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

_env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)

_FIT_SUFFIXES = {".fit", ".fits"}


@dataclass
class LightSelection:
    """Describes a human-filtered subset of a night's raw lights: symlink
    every file in source_dir except those named in `exclude` into
    dest_dir. Built by _resolve_nights() when exclude_frames is non-empty;
    applied by apply_light_selections() right before a job runs (never
    inside render_*(), which stays a side-effect-free dry run).
    """

    source_dir: Path
    dest_dir: Path
    exclude: frozenset[str]


@dataclass
class RenderedScript:
    text: str
    # Directories the script `cd`s into or writes -out= into that Siril
    # will NOT create for us: `convert ... -out=<dir>` requires <dir> to
    # already exist (confirmed empirically — it does not mkdir it), and
    # `cd` itself needs its target to already exist and be writable
    # (Handoff.md gotcha #2). The caller must mkdir these before running
    # the script; render_*() itself stays a pure, side-effect-free dry run.
    # Used for directories that hold PERSISTENT output (master_bias.fit
    # etc.) that must survive across runs — never wiped.
    ensure_dirs: list[Path] = field(default_factory=list)
    # Disposable per-run scratch workspaces (light conversion/registration)
    # that the caller must wipe-and-recreate via prepare_fresh_dirs() before
    # running the script — see gotcha #6 in Handoff.md: Siril's `calibrate`
    # rescans its whole cwd by filename pattern, so any files left over
    # from a *previous* run with a different frame count get silently
    # folded into the new sequence. Never reuse these across runs.
    fresh_dirs: list[Path] = field(default_factory=list)
    # Frame-exclusion symlink trees the caller must populate (via
    # apply_light_selections()) before running the script — see
    # LightSelection above.
    light_selections: list[LightSelection] = field(default_factory=list)
    # Resolved per-night {key, raw_lights, process_dir} dicts, for callers
    # that need to locate output after the job runs.
    nights: list[dict] = field(default_factory=list)


def apply_light_selections(selections: list[LightSelection]) -> None:
    """Populate each LightSelection's dest_dir from scratch (removing any
    stale symlinks from a previous run with a different exclude list),
    symlinking every raw light frame except the excluded basenames.
    """
    for sel in selections:
        if sel.dest_dir.exists():
            shutil.rmtree(sel.dest_dir)
        sel.dest_dir.mkdir(parents=True, exist_ok=True)
        for src in sorted(sel.source_dir.iterdir()):
            if src.suffix.lower() not in _FIT_SUFFIXES:
                continue
            if src.name in sel.exclude:
                continue
            (sel.dest_dir / src.name).symlink_to(src.resolve())


def prepare_fresh_dirs(dirs: list[Path]) -> None:
    """Wipe and recreate each directory from scratch. Used for the
    disposable light-conversion workspace (process/lights or
    process/nights/<name>/lights) right before every /stack/run or
    /lights/analyze/run — never for directories holding persistent master
    files. See RenderedScript.fresh_dirs and Handoff.md gotcha #6.
    """
    for d in dirs:
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)


def render_build_masters(project: Path, req: BuildMastersRequest) -> RenderedScript:
    raw = project / "raw"
    process = project / "process"
    build_bias = (raw / "biases").is_dir()
    build_dark = (raw / "darks").is_dir()

    flat_targets: list[dict] = []
    ensure_dirs = [process]

    # Absolute: each night's flats are calibrated from a *different*
    # process_dir than the shared master_bias lives in.
    bias_arg_abs = str(process / "master_bias") if build_bias else None
    for name in req.nights:
        if not name or "/" in name or name in (".", ".."):
            raise ValueError(f"invalid night name: {name!r}")
        flats_dir = raw / "nights" / name / "flats"
        if flats_dir.is_dir():
            night_process = process / "nights" / name
            flat_targets.append(
                {
                    "label": name,
                    "raw_flats": str(flats_dir),
                    "process_dir": str(night_process),
                    "bias_arg": bias_arg_abs,
                }
            )
            ensure_dirs.append(night_process)

    template = _env.get_template("build_masters.ssf.j2")
    text = template.render(
        build_bias=build_bias,
        build_dark=build_dark,
        raw_biases=str(raw / "biases"),
        raw_darks=str(raw / "darks"),
        process_dir=str(process),
        stack_cmd=req.stack.to_ssf(),
        flat_targets=flat_targets,
    )
    return RenderedScript(text=text, ensure_dirs=ensure_dirs)


def _resolve_nights(
    project: Path, req: StackLightsRequest
) -> tuple[list[dict], str, list[LightSelection], Path | None]:
    """Night/master resolution for /stack/run. Returns
    (nights, dark_master, light_selections, merge_dir), raising
    ValueError (-> HTTP 400 in main.py) for anything that would otherwise
    reach siril-cli as a silent, confusing failure: a bad night name, a
    missing lights directory, or a missing master file (see Handoff.md
    gotcha #4 and the 2026-09-20 "string" placeholder incident this
    validation was added for).

    Every project always uses the raw/nights/<name>/{lights,flats} layout
    — there is no separate single-night layout (dropped 2026-09-20 after
    hitting exactly the bug that layout duality invites: a request with no
    `nights` silently assumed a raw/lights/ that a multi-night-staged
    project never had). `nights` is required and non-empty (enforced by
    StackLightsRequest's Field(..., min_length=1)); a "single-night"
    project is simply one that only has one entry in `nights`.

    Each night's `process_dir` is a disposable conversion workspace
    (process/nights/<name>/lights) — deliberately *separate* from wherever
    that night's persistent master_flat.fit lives, and always wiped fresh
    by prepare_fresh_dirs() before a run (see gotcha #6: reusing a
    directory that still has a *previous* run's numbered frame files in
    it gets them silently folded into the new sequence by Siril's own
    directory rescan).

    `merge_dir` is an additional disposable workspace for the final
    merge/register/stack step, needed only when there are 2+ nights: with
    exactly one, that step just reuses the one night's own process_dir
    directly. This isn't an arbitrary simplification — Siril's `merge`
    command's own usage string is `merge sequence1 sequence2
    [sequence3 ...] output_sequence`; it hard-refuses to run with fewer
    than two inputs (confirmed the hard way, 2026-09-20), so a single
    night genuinely cannot go through the same merge step as multiple.
    """
    raw = project / "raw"
    process = project / "process"

    nights: list[dict] = []
    for name in req.nights:
        if not name or "/" in name or name in (".", ".."):
            raise ValueError(f"invalid night name: {name!r}")
        nights.append(
            {
                "key": name,
                "raw_lights": raw / "nights" / name / "lights",
                "process_dir": process / "nights" / name / "lights",
                "flat_master": req.master_flat or str(process / "nights" / name / "master_flat"),
            }
        )
    merge_dir = process / "lights" / "_merged" if len(nights) > 1 else None

    dark_master = req.master_dark or str(process / "master_dark")

    selections: list[LightSelection] = []
    for night in nights:
        raw_lights: Path = night["raw_lights"]
        if not raw_lights.is_dir():
            raise ValueError(
                f"lights directory not found: {str(raw_lights)!r} (check the "
                "project's raw/ layout, or the `nights` list if this is a "
                "multi-night request)"
            )
        if req.exclude_frames:
            selected_dir = process / "_selected" / night["key"] / "lights"
            selections.append(
                LightSelection(
                    source_dir=raw_lights,
                    dest_dir=selected_dir,
                    exclude=frozenset(req.exclude_frames),
                )
            )
            night["raw_lights"] = selected_dir
        else:
            night["raw_lights"] = raw_lights

    def _master_exists(master: str) -> bool:
        return Path(master).exists() or Path(master + ".fit").exists()

    if not _master_exists(dark_master):
        raise ValueError(
            f"master dark not found at {dark_master!r} (or {dark_master}.fit) "
            "— build masters first via /masters/run, or pass an explicit "
            "master_dark override"
        )
    for night in nights:
        flat_master = night["flat_master"]
        if not _master_exists(flat_master):
            raise ValueError(
                f"master flat not found at {flat_master!r} (or {flat_master}.fit) "
                f"for night {night['key']!r} — build masters first via "
                "/masters/run (with matching `nights`), or pass an explicit "
                "master_flat override"
            )

    return nights, dark_master, selections, merge_dir


def render_stack_lights(project: Path, req: StackLightsRequest) -> RenderedScript:
    nights, dark_master, selections, merge_dir = _resolve_nights(project, req)
    osc_flags = " -cfa -equalize_cfa -debayer" if req.is_osc else ""
    needs_merge = merge_dir is not None
    base_process_dir = merge_dir if needs_merge else nights[0]["process_dir"]

    template = _env.get_template("calibrate_stack.ssf.j2")
    text = template.render(
        nights=nights,
        merge=needs_merge,
        dark_master=dark_master,
        cc_flag=" -cc=dark",
        osc_flags=osc_flags,
        stack_cmd=req.stack.to_ssf(),
        base_process_dir=str(base_process_dir),
    )
    fresh_dirs = [Path(n["process_dir"]) for n in nights]
    if merge_dir is not None:
        fresh_dirs.append(merge_dir)
    return RenderedScript(text=text, fresh_dirs=fresh_dirs, light_selections=selections, nights=nights)
