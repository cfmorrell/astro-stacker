"""Renders .ssf scripts from the templates/ dir.

The single-night path in render_stack_lights() is deliberately kept
identical in structure to the hand-validated script in Handoff.md
("Validated .ssf script" section) — convert -> calibrate -> register
pp_light -> stack r_pp_light — just with the stack method and master
paths parameterized. Multi-night stacking is new (not yet validated
against real multi-night data) and uses Siril's `merge` across each
night's pp_light sequence, following the pattern in rolandet's
osc-multi-night-stacking script (GPLv3, referenced for structure only,
per Handoff.md's licensing note).
"""

from __future__ import annotations

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


@dataclass
class RenderedScript:
    text: str
    # Directories the script `cd`s into or writes -out= into that Siril
    # will NOT create for us: `convert ... -out=<dir>` requires <dir> to
    # already exist (confirmed empirically — it does not mkdir it), and
    # `cd` itself needs its target to already exist and be writable
    # (Handoff.md gotcha #2). The caller must mkdir these before running
    # the script; render_*() itself stays a pure, side-effect-free dry run.
    ensure_dirs: list[Path] = field(default_factory=list)


def render_build_masters(project: Path, req: BuildMastersRequest) -> RenderedScript:
    raw = project / "raw"
    process = project / "process"
    build_bias = (raw / "biases").is_dir()
    template = _env.get_template("build_masters.ssf.j2")
    text = template.render(
        build_bias=build_bias,
        build_dark=(raw / "darks").is_dir(),
        build_flat=(raw / "flats").is_dir(),
        raw_biases=str(raw / "biases"),
        raw_darks=str(raw / "darks"),
        raw_flats=str(raw / "flats"),
        process_dir=str(process),
        stack_cmd=req.stack.to_ssf(),
        # Flat calibration wants the bias we just built, if any; -bias here
        # is relative because it's read back from the same process_dir the
        # flat conversion just cd'd into.
        bias_arg="master_bias" if build_bias else None,
    )
    return RenderedScript(text=text, ensure_dirs=[process])


def render_stack_lights(project: Path, req: StackLightsRequest) -> RenderedScript:
    raw = project / "raw"
    process = project / "process"
    single = len(req.nights) == 1 and req.nights[0] == ""

    nights = []
    if single:
        nights.append(
            {
                "raw_lights": str(raw / "lights"),
                "process_dir": str(process),
            }
        )
    else:
        for name in req.nights:
            if not name or "/" in name or name in (".", ".."):
                raise ValueError(f"invalid night name: {name!r}")
            nights.append(
                {
                    "raw_lights": str(raw / name / "lights"),
                    "process_dir": str(process / "lights" / name),
                }
            )

    # No extension: Siril's calibrate -dark=/-flat= take a bare name and
    # resolve the .fit/.fits/.fit.fz file themselves, matching how the
    # validated script references "master_dark"/"master_flat" (produced by
    # `stack ... -out=master_dark`, never written with an extension in the
    # command itself).
    dark_master = req.master_dark or str(process / "master_dark")
    flat_master = req.master_flat or str(process / "master_flat")
    osc_flags = " -cfa -equalize_cfa -debayer" if req.is_osc else ""

    template = _env.get_template("calibrate_stack.ssf.j2")
    text = template.render(
        nights=nights,
        single=single,
        dark_master=dark_master,
        flat_master=flat_master,
        cc_flag=" -cc=dark",
        osc_flags=osc_flags,
        stack_cmd=req.stack.to_ssf(),
        base_process_dir=nights[0]["process_dir"],
    )
    return RenderedScript(text=text, ensure_dirs=[Path(n["process_dir"]) for n in nights])
