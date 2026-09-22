"""Renders .ssf scripts from the templates/ dir.

Every project uses one universal layout — there is no separate
single-night mode (dropped 2026-09-20; see _resolve_nights()'s docstring
for why: a dual layout meant an unspecified `nights` could silently
assume a raw/lights/ that a multi-night-staged project never had). A
"single-night" project is just one whose `nights` list happens to have
one entry.

The command sequence itself — convert -> calibrate -> register -> stack —
is kept identical in structure to the hand-validated script in
Handoff.md ("Validated .ssf script" section), just with the stack method
and master paths parameterized, and (2026-09-2x) split across several
independent siril-cli invocations rather than one combined script — see
render_build_masters()/render_stack_lights()'s docstrings and Handoff.md
gotcha #8: running multiple sequences' calibrate+register in *one* Siril
session is a severe, confirmed performance cliff (10s alone vs 90s as the
2nd sequence in one process, for identical work), not just additive cost.
With 2+ nights, their pp_light sequences are combined via Siril's `merge`
in a final step (Siril requires at least two inputs to `merge` — confirmed
the hard way, gotcha #7 — so exactly one night skips this and
registers/stacks its own sequence directly), following the pattern in
rolandet's osc-multi-night-stacking script (GPLv3, referenced for
structure only, per Handoff.md's licensing note).

Raw/process layout:
    raw/biases, raw/darks                     — shared across the project
    raw/nights/<name>/{lights,flats}          — every night, always
    process/master_bias, process/master_dark  — always shared, stable
    process/nights/<name>/master_flat         — per-night, stable
    process/_build/{bias,dark}                — disposable scratch (masters)
    process/_build/nights/<name>/flat         — disposable scratch (masters)
    process/nights/<name>/lights              — disposable scratch (stack)
    process/lights/_merged                    — disposable scratch, 2+ nights only
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from jinja2 import Environment, FileSystemLoader

from . import config, frameinfo
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
class SirilStep:
    """One independent siril-cli invocation. Callers (main.py) run each
    step as its own subprocess in order — see Handoff.md gotcha #8 for
    why this is no longer one combined script covering every night/master.
    """

    script: str
    workdir: Path  # siril-cli's -d for this step
    label: str  # e.g. "master_bias", "night1 calibrate", "merge+register+stack"
    # Wiped via prepare_fresh_dirs() before this step runs. None means
    # "don't wipe" — e.g. the final single-night register/stack step
    # reuses the SAME dir its own preceding calibrate step just populated;
    # wiping it here would delete the pp_light sequence just built.
    fresh_dir: Optional[Path] = None
    # (scratch_output_file, stable_destination) to move after this step
    # succeeds and before the next step starts — e.g. master_bias.fit
    # moving to its stable path so a later flat-build step can reference
    # it there. See Handoff.md gotcha #6.
    move: Optional[tuple[Path, Path]] = None


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
    """Wipe and recreate each directory from scratch. Used for every
    disposable scratch workspace right before a job's steps run — never
    for directories holding persistent master/result files. See
    SirilStep.fresh_dir and Handoff.md gotcha #6.
    """
    for d in dirs:
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)


def perform_move(move: tuple[Path, Path]) -> None:
    """Move a step's scratch output to its stable location, creating the
    destination's parent dir if needed. Overwrites an existing file at
    the destination (os.rename()'s normal POSIX behavior via shutil.move)
    — rebuilding a master is expected to replace the old one.
    """
    src, dst = move
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))


def render_build_masters(project: Path, req: BuildMastersRequest) -> list[SirilStep]:
    """Build shared master bias/dark and one master flat per named night,
    each as its OWN siril-cli invocation into its own disposable scratch
    dir (Handoff.md gotchas #6 and #8), moved to its stable location
    (process/master_bias.fit, process/master_dark.fit,
    process/nights/<name>/master_flat.fit) once that step succeeds.

    Steps run in order: bias, then dark, then each night's flat. Bias is
    built (and MOVED to its stable path) before any flat step runs, since
    a flat's calibration needs to reference the bias — see
    build_master_flat.ssf.j2's docstring for why that reference is to the
    bias step's own scratch output, not a not-yet-created stable path, on
    the rare occasion bias and a flat both build in the same request but
    bias is skipped (no raw/biases): then there's nothing to move and no
    -bias= argument at all.
    """
    raw = project / "raw"
    process = project / "process"
    build_root = process / "_build"
    build_bias = (raw / "biases").is_dir()
    build_dark = (raw / "darks").is_dir()

    steps: list[SirilStep] = []

    if build_bias:
        scratch = build_root / "bias"
        text = _env.get_template("build_master_bias.ssf.j2").render(
            raw_dir=str(raw / "biases"),
            process_dir=str(scratch),
            stack_cmd=req.stack.to_ssf(),
        )
        steps.append(
            SirilStep(
                script=text,
                workdir=scratch,
                label="master_bias",
                fresh_dir=scratch,
                move=(scratch / "master_bias.fit", process / "master_bias.fit"),
            )
        )

    if build_dark:
        scratch = build_root / "dark"
        text = _env.get_template("build_master_dark.ssf.j2").render(
            raw_dir=str(raw / "darks"),
            process_dir=str(scratch),
            stack_cmd=req.stack.to_ssf(),
        )
        steps.append(
            SirilStep(
                script=text,
                workdir=scratch,
                label="master_dark",
                fresh_dir=scratch,
                move=(scratch / "master_dark.fit", process / "master_dark.fit"),
            )
        )

    # Absolute: the bias step's own on_success move (see the step appended
    # above) has already relocated master_bias.fit to this stable path by
    # the time any flat step runs — steps execute strictly in order, and
    # shutil.move() actually *removes* the scratch copy (confirmed the
    # hard way: an earlier version of this pointed at the bias step's
    # scratch dir and broke, since that file is gone once moved, not
    # copied). Bias's *raw scratch dir* (biases_*.fit, bias_.seq) is left
    # behind, but the stacked master itself is not.
    bias_arg_abs = str(process / "master_bias") if build_bias else None

    for name in req.nights:
        if not name or "/" in name or name in (".", ".."):
            raise ValueError(f"invalid night name: {name!r}")
        flats_dir = raw / "nights" / name / "flats"
        if not flats_dir.is_dir():
            continue
        scratch = build_root / "nights" / name / "flat"
        text = _env.get_template("build_master_flat.ssf.j2").render(
            raw_dir=str(flats_dir),
            process_dir=str(scratch),
            stack_cmd=req.stack.to_ssf(),
            bias_arg=bias_arg_abs,
        )
        steps.append(
            SirilStep(
                script=text,
                workdir=scratch,
                label=f"master_flat ({name})",
                fresh_dir=scratch,
                move=(scratch / "master_flat.fit", process / "nights" / name / "master_flat.fit"),
            )
        )

    return steps


_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _format_integration(total_seconds: float) -> str:
    # Rounds to whole minutes FIRST, then splits into h/m - avoids a
    # rounding-carry bug (e.g. 59.6 minutes must become "1h0m", not
    # "0h60m") that computing hours and minutes as separate roundings
    # independently would risk.
    total_minutes = round(total_seconds / 60)
    hours, minutes = divmod(total_minutes, 60)
    if hours == 0:
        return f"{minutes}m"
    return f"{hours}h{minutes}m" if minutes else f"{hours}h"


def output_basename(project: Path, total_seconds: float, filters: frozenset[str] = frozenset()) -> str:
    """The final stacked file's name (without extension): the project
    name, its filter(s) if any, and total integration time actually
    going into this stack (Chris: "rename output file as Project Name +
    total integration time", format "1h12m" not "1.2h" per follow-up
    feedback) — e.g. "ElephantTrunkNebula-IC1396_5h24m" for OSC data, or
    "HeartNebula-IC1805_H_1h15m" for a mono/narrowband stack, so the
    filter is recoverable from the filename alone when combining several
    filters' results later (in other software - out of scope here).
    Falls back to just the project name if no frame's exposure could be
    determined at all, rather than a misleading "_0m". Multiple distinct
    filters (only possible by ignoring the Stack step's own mismatch
    warning - see checkStackFilterMismatch() in app.js) are joined with
    "+" rather than silently picking one.
    """
    safe_name = _SAFE_NAME_RE.sub("_", project.name).strip("_") or project.name
    if filters:
        safe_name = f"{safe_name}_{'+'.join(sorted(filters))}"
    if total_seconds <= 0:
        return safe_name
    return f"{safe_name}_{_format_integration(total_seconds)}"


def _resolve_nights(
    project: Path, req: StackLightsRequest
) -> tuple[list[dict], list[LightSelection], Path | None, float]:
    """Night/master resolution for /stack/run. Returns
    (nights, light_selections, merge_dir, total_light_seconds), raising
    ValueError (-> HTTP 400 in main.py) for anything that would otherwise
    reach siril-cli as a silent, confusing failure: a bad night name, a
    missing lights directory, or a missing master file (see Handoff.md
    gotcha #4 and the 2026-09-20 "string" placeholder incident this
    validation was added for).

    Each night's dark_master/flat_master come from this project's
    calibration overrides (project meta, set via
    /projects/{name}/calibration-overrides — see
    CalibrationOverridesRequest) when present, falling back to the
    normal shared process/master_dark / that night's own
    process/nights/<name>/master_flat otherwise. dark_master is
    genuinely per-night now (not one shared value for every night in the
    request) so a project spanning months can use a different dark for a
    night shot under different conditions. Either can resolve to None —
    no override AND nothing built for the default — in which case that
    night's calibrate step simply omits that argument (Siril's own
    -dark=/-flat=/-cc= are all optional) rather than failing; an
    override that's set but doesn't actually exist on disk is still a
    hard error, since that's a real mistake, not "nothing available."

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
    meta = config.read_project_meta(project)
    dark_overrides: dict = meta.get("night_dark_overrides", {})
    flat_overrides: dict = meta.get("night_flat_overrides", {})
    night_filters: dict = meta.get("night_filters", {})

    def _master_exists(master: str) -> bool:
        return Path(master).exists() or Path(master + ".fit").exists()

    def _resolve_master(explicit: Optional[str], default: str, kind: str, night_name: str) -> Optional[str]:
        """An explicitly-set override that doesn't actually exist is a real
        mistake worth a hard error; a default (nothing built, no override)
        that's simply not there just means "skip this calibration step for
        this night" — Chris: "can we stack successfully if we skip past
        the calibration frame process entirely?" Siril's own `calibrate`
        command already treats -dark=/-flat= as fully optional (confirmed
        via `help calibrate`), so this mirrors that rather than assuming
        every project has full calibration frames.
        """
        if explicit:
            if not _master_exists(explicit):
                raise ValueError(
                    f"master {kind} override not found at {explicit!r} (or "
                    f"{explicit}.fit) for night {night_name!r} — check the "
                    "calibration alignment set for this night"
                )
            return explicit
        return default if _master_exists(default) else None

    nights: list[dict] = []
    for name in req.nights:
        if not name or "/" in name or name in (".", ".."):
            raise ValueError(f"invalid night name: {name!r}")
        nights.append(
            {
                "key": name,
                "raw_lights": raw / "nights" / name / "lights",
                "process_dir": process / "nights" / name / "lights",
                "dark_master": _resolve_master(dark_overrides.get(name), str(process / "master_dark"), "dark", name),
                "flat_master": _resolve_master(
                    flat_overrides.get(name), str(process / "nights" / name / "master_flat"), "flat", name
                ),
                "filter": night_filters.get(name),
            }
        )
    merge_dir = process / "lights" / "_merged" if len(nights) > 1 else None

    exclude = frozenset(req.exclude_frames)

    selections: list[LightSelection] = []
    total_seconds = 0.0
    for night in nights:
        raw_lights: Path = night["raw_lights"]
        if not raw_lights.is_dir():
            raise ValueError(
                f"lights directory not found: {str(raw_lights)!r} (check the "
                "project's raw/ layout, or the `nights` list if this is a "
                "multi-night request)"
            )
        # Computed from the RAW dir (before the selected/filtered dir
        # below is substituted in) minus excluded names, rather than from
        # whatever raw_lights ends up pointing at - the selected dir is
        # only actually populated on disk later, by
        # apply_light_selections(), well after this function returns.
        for f in raw_lights.iterdir():
            if f.suffix.lower() not in _FIT_SUFFIXES or f.name in exclude:
                continue
            seconds = frameinfo.parse_exposure_seconds(f.name)
            if seconds is not None:
                total_seconds += seconds
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

    return nights, selections, merge_dir, total_seconds


def render_stack_lights(
    project: Path, req: StackLightsRequest
) -> tuple[list[SirilStep], list[dict], list[LightSelection], str]:
    """Calibrate each night independently (its own siril-cli process —
    Handoff.md gotcha #8), then register+stack (single night) or
    merge+register+stack (2+ nights) in one final step. Returns
    (steps, nights, light_selections, output_basename) — `nights` (the
    resolved per-night dicts) is exposed for callers that need to locate
    output after the job runs; `light_selections` must be applied via
    apply_light_selections() before the job's steps run, same as before;
    `output_basename` (project name, filter if any, and total integration
    time, e.g. "ElephantTrunkNebula-IC1396_5h24m" or, for a mono/
    narrowband stack, "HeartNebula-IC1805_H_1h15m") is the actual `-out=`
    filename used below, exposed so main.py can record it in project meta
    for /status to find the result afterward (see output_basename()'s
    docstring — a project's Siril output is no longer always "result").
    """
    nights, selections, merge_dir, total_seconds = _resolve_nights(project, req)
    filters = frozenset(n["filter"] for n in nights if n["filter"])
    output_name = output_basename(project, total_seconds, filters)

    # Siril's own drizzle docs (confirmed via `help register`): "when
    # using -drizzle on images taken with a color camera, the input
    # images must not be debayered" - -cfa (cosmetic correction) and
    # -equalize_cfa (flat tint correction) still apply either way, only
    # -debayer itself is conditional on drizzle being off.
    if req.is_osc:
        osc_flags = " -cfa -equalize_cfa" + ("" if req.drizzle.enabled else " -debayer")
    else:
        osc_flags = ""
    register_flags = req.drizzle.to_ssf()

    steps: list[SirilStep] = []
    calibrate_tpl = _env.get_template("calibrate_night.ssf.j2")
    for night in nights:
        process_dir: Path = night["process_dir"]
        text = calibrate_tpl.render(
            raw_lights=str(night["raw_lights"]),
            process_dir=str(process_dir),
            dark_master=night["dark_master"],
            flat_master=night["flat_master"],
            # -cc=dark detects hot/cold pixels FROM the dark master, so it
            # needs one to reference - can't be used without one.
            cc_flag=" -cc=dark" if night["dark_master"] else "",
            osc_flags=osc_flags,
        )
        steps.append(
            SirilStep(
                script=text,
                workdir=process_dir,
                label=f"{night['key']} calibrate",
                fresh_dir=process_dir,
            )
        )

    if merge_dir is not None:
        text = _env.get_template("register_stack_merge.ssf.j2").render(
            merge_dir=str(merge_dir),
            pp_light_dirs=[str(n["process_dir"]) for n in nights],
            stack_cmd=req.stack.to_ssf(),
            register_flags=register_flags,
            output_name=output_name,
        )
        steps.append(
            SirilStep(
                script=text,
                workdir=merge_dir,
                label="merge+register+stack",
                fresh_dir=merge_dir,
            )
        )
    else:
        only = nights[0]["process_dir"]
        text = _env.get_template("register_stack_single.ssf.j2").render(
            process_dir=str(only),
            stack_cmd=req.stack.to_ssf(),
            register_flags=register_flags,
            output_name=output_name,
        )
        # fresh_dir=None: this reuses the SAME dir the one calibrate step
        # above just populated with pp_light — wiping it here would
        # delete that sequence before register ever sees it.
        steps.append(SirilStep(script=text, workdir=only, label="register+stack"))

    return steps, nights, selections, output_name
