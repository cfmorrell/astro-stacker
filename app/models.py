"""Request models for the /masters and /stack endpoints.

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
    """Build master bias/dark/flat from project_dir/raw/{biases,darks,flats}.

    Any of the three raw/ subdirectories that don't exist are skipped
    (e.g. reusing an existing master_bias.fit from a prior run and only
    rebuilding darks/flats).
    """

    stack: StackOptions = Field(default_factory=StackOptions)


class StackLightsRequest(BaseModel):
    """Calibrate, register, and stack lights into project_dir/process/result.fit.

    `nights`: for the common single-night layout (matches the validated
    script and existing test1 project), leave this as [""] — lights are
    read from raw/lights directly. For multi-night stacking, pass the
    night subdirectory names (e.g. ["2026-08-29", "2026-08-30"]); each
    night's lights must be staged at raw/<name>/lights, and its pp_light
    sequence is registered/stacked together via Siril's `merge`.
    """

    nights: list[str] = Field(default_factory=lambda: [""])
    stack: StackOptions = Field(default_factory=StackOptions)
    is_osc: bool = True  # False drops -cfa/-equalize_cfa/-debayer for mono cameras
    master_dark: Optional[str] = None  # absolute path override; default process/master_dark
    master_flat: Optional[str] = None  # absolute path override; default process/master_flat
