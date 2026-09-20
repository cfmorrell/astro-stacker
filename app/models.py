"""Request models for the /masters, /stack, /lights, and /projects endpoints.

The stacking-algorithm knob referenced in Handoff.md ("the few different
stacking algorithms Chris wants in the web UI") is exactly the `stack ...`
line's method token in the validated .ssf — see StackMethod/StackOptions.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class StackMethod(str, Enum):
    rejection = "rej"  # sigma-clipped rejection stacking (validated default: rej 3 3)
    median = "med"
    sum = "sum"
    maximum = "max"
    minimum = "min"


class StackOptions(BaseModel):
    method: StackMethod = StackMethod.rejection
    sigma_low: float = 3.0
    sigma_high: float = 3.0

    def to_ssf(self) -> str:
        """Render the method portion of a Siril `stack` command line."""
        if self.method == StackMethod.rejection:
            return f"rej {self.sigma_low:g} {self.sigma_high:g}"
        return self.method.value


class BuildMastersRequest(BaseModel):
    """Build master bias/dark (always shared across the whole project) and
    one master flat per named night, from project_dir/raw/{biases,darks}
    and project_dir/raw/nights/<name>/flats.

    `nights` is required and must name every night whose flats should get
    a master built (every project always uses the raw/nights/<name>/...
    layout — see /projects/{name}/stage — even a "single-night" project is
    just one name here; there is no separate flat/legacy layout to
    remember to ask about). Bias/dark are never per-night — per Chris:
    "usually a single set of bias and dark images that will apply across
    all nights."

    Any raw/ subdirectory that doesn't exist (including a given night's
    flats/) is skipped rather than erroring, so re-running this only
    rebuilds what's missing (e.g. adding a new night's flats later without
    rebuilding the shared bias/dark).
    """

    stack: StackOptions = Field(default_factory=StackOptions)
    nights: list[str] = Field(..., min_length=1)

    model_config = {
        "json_schema_extra": {
            "example": {
                "stack": {"method": "rej", "sigma_low": 3.0, "sigma_high": 3.0},
                "nights": ["night1"],
            }
        }
    }


class LightsSelectionRequest(BaseModel):
    """Shared fields for anything that operates over a project's light
    frames: calibrate+register+stack (StackLightsRequest) or calibrate+
    register only, for human review (AnalyzeLightsRequest).

    `nights` is required — every project always uses the
    raw/nights/<name>/{lights,flats} layout (see /projects/{name}/stage
    and BuildMastersRequest), even for a project that only has one
    session; there is no separate single-night layout to remember or ask
    about. Each named night's lights are read from raw/nights/<name>/lights
    and calibrated against ITS OWN process/nights/<name>/master_flat by
    default (flats vary night to night), while `master_dark` stays a
    single shared value across every night. With exactly one name, that
    night's own sequence is registered/stacked directly; with two or more,
    they're combined first via Siril's `merge` (which — confirmed the hard
    way — refuses to run with fewer than two inputs, hence the split).
    """

    nights: list[str] = Field(..., min_length=1)
    is_osc: bool = True  # False drops -cfa/-equalize_cfa/-debayer for mono cameras
    master_dark: Optional[str] = None  # absolute path override; default process/master_dark (shared)
    master_flat: Optional[str] = None  # override applied to ALL nights uniformly; default is per-night
    exclude_frames: list[str] = Field(default_factory=list)  # raw light frame basenames to skip (see /lights/analyze)


class StackLightsRequest(LightsSelectionRequest):
    """Calibrate, register, and stack lights into project_dir/process/result.fit
    (or process/nights/.../result.fit's merged equivalent for multi-night)."""

    stack: StackOptions = Field(default_factory=StackOptions)

    model_config = {
        # FastAPI/Swagger has no way to know [] is a meaningful sentinel
        # (single-night default) rather than an empty placeholder, and its
        # auto-generated "Example Value" otherwise fills every plain
        # str/list[str] field with the literal word "string" — which is a
        # valid-looking night name and silently produces raw/string/lights,
        # a directory that will never exist (hit this for real 2026-09-20).
        # This explicit example is what Swagger UI shows instead, so "Try
        # it out" round-trips a request that actually works unedited.
        "json_schema_extra": {
            "example": {
                "nights": ["night1"],
                "stack": {"method": "rej", "sigma_low": 3.0, "sigma_high": 3.0},
                "is_osc": True,
                "master_dark": None,
                "master_flat": None,
                "exclude_frames": [],
            }
        }
    }


class AnalyzeLightsRequest(LightsSelectionRequest):
    """Calibrate+register lights only (no stacking) purely to compute
    per-frame quality metrics for human review — FWHM, roundness
    (eccentricity proxy), background, and star count, all sourced from
    Siril's own `register` step rather than reimplementing star detection.
    Nothing is excluded automatically; see the /lights/analyze endpoint and
    Handoff.md for the astropup-blink-style "recommend, don't auto-filter"
    design this follows.
    """

    model_config = {
        "json_schema_extra": {
            "example": {
                "nights": ["night1"],
                "is_osc": True,
                "master_dark": None,
                "master_flat": None,
                "exclude_frames": [],
            }
        }
    }


class NightSource(BaseModel):
    """One night's lights+flats to stage, as a source-folder -> internal-name
    mapping. `name` is chosen by the caller and is what actually lands on
    disk (raw/nights/<name>/...) — source folder names (e.g. "Night 1",
    with a space) never need to match any naming convention.
    """

    name: str
    lights_dir: str  # path relative to CAPTURES_DIR, e.g. "Night 1/lights"
    flats_dir: str  # path relative to CAPTURES_DIR, e.g. "Night 1/flats"

    model_config = {
        "json_schema_extra": {
            "example": {"name": "night1", "lights_dir": "Night 1/lights", "flats_dir": "Night 1/flats"}
        }
    }


class StageProjectRequest(BaseModel):
    """Symlinks raw frames from CAPTURES_DIR into this project's raw/ tree
    (creating the project directory if needed), replacing manual
    `mkdir` + `scripts/stage_captures.sh` invocation. Bias/dark are shared
    (staged once, at raw/biases and raw/darks); each entry in `nights`
    stages its own lights+flats at raw/nights/<name>/{lights,flats}.
    """

    biases_dir: Optional[str] = "biases"  # relative to CAPTURES_DIR; None = skip staging biases
    darks_dir: Optional[str] = "darks"  # relative to CAPTURES_DIR; None = skip staging darks
    nights: list[NightSource] = Field(default_factory=list)

    model_config = {
        "json_schema_extra": {
            "example": {
                "biases_dir": "biases",
                "darks_dir": "darks",
                "nights": [
                    {"name": "night1", "lights_dir": "Night 1/lights", "flats_dir": "Night 1/flats"},
                    {"name": "night2", "lights_dir": "Night 2/lights", "flats_dir": "Night 2/flats"},
                ],
            }
        }
    }
