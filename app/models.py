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
    """Per `siril-cli`'s own `help stack` (1.4.3): `rej`/`mean` are the same
    stack type, with a REJECTION TYPE sub-argument (sigma, winsorized,
    none, percentile, median, linear, generalized, mad — Winsorized is
    Siril's own default if omitted). Chris asked to narrow the UI to just
    these three (2026-09-2x): plain sigma-clipping, Winsorized sigma
    (usually the better-behaved choice against outliers with small
    per-night frame counts), and a plain mean (rejection type `none` — no
    clipping at all, so sigma_low/sigma_high are meaningless for it).
    """

    rejection_sigma = "sigma"
    winsorized_sigma = "winsorized"
    mean = "none"


class StackOptions(BaseModel):
    method: StackMethod = StackMethod.winsorized_sigma
    sigma_low: float = 3.0
    sigma_high: float = 3.0

    def to_ssf(self) -> str:
        """Render the method portion of a Siril `stack` command line."""
        if self.method == StackMethod.mean:
            return "rej none"
        return f"rej {self.method.value} {self.sigma_low:g} {self.sigma_high:g}"


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
                "stack": {"method": "winsorized", "sigma_low": 3.0, "sigma_high": 3.0},
                "nights": ["night1"],
            }
        }
    }


class DrizzleKernel(str, Enum):
    point = "point"
    turbo = "turbo"
    square = "square"
    gaussian = "gaussian"
    lanczos2 = "lanczos2"
    lanczos3 = "lanczos3"


class DrizzleOptions(BaseModel):
    """Maps directly to `register`'s `-drizzle` sub-options (per `siril-cli`'s
    own `help register`, 1.4.3). `scale` is register's own `-scale=` option
    (0.1-3.0) — a plain rescale that isn't drizzle-specific but is normally
    paired with it (e.g. 2x drizzle for oversampled/undersampled data).

    IMPORTANT interaction confirmed from Siril's own help text: "when using
    -drizzle on images taken with a color camera, the input images must not
    be debayered" — see ssf.py's render_stack_lights(), which drops the
    `-debayer` calibrate flag (but keeps `-cfa`/`-equalize_cfa`) whenever
    this is enabled on an OSC project.
    """

    enabled: bool = False
    scale: float = Field(default=2.0, ge=0.1, le=3.0)  # Chris: default to 2x, not 1x (no upscale)
    pixel_fraction: float = Field(default=1.0, gt=0.0, le=2.0)
    kernel: DrizzleKernel = DrizzleKernel.square

    def to_ssf(self) -> str:
        if not self.enabled:
            return ""
        return f" -drizzle -scale={self.scale:g} -pixfrac={self.pixel_fraction:g} -kernel={self.kernel.value}"


class CalibrationOverridesRequest(BaseModel):
    """Per-night dark/flat master alignment for a project — Chris's own
    framing: "aligning calibration frames to nights." Lives in project
    meta (set via /projects/{name}/calibration-overrides, read back by
    /status), not on a per-stack-run request, since it's a property of
    how this project's calibration is set up rather than something to
    re-specify every time a stack runs.

    Each dict maps a night's internal name to an absolute .fit path to
    use INSTEAD of that night's normal default (the shared
    process/master_dark for dark; that night's own
    process/nights/<name>/master_flat for flat) — e.g. a long-running
    project spanning months might use a different dark for a night shot
    at a different camera temperature, or borrow another night's flat
    for a night that never got its own. A night simply absent from
    either dict uses its normal default; this is the full desired state
    each call (the frontend always resends its complete current
    picture), not a partial merge.
    """

    night_dark_overrides: dict[str, str] = Field(default_factory=dict)
    night_flat_overrides: dict[str, str] = Field(default_factory=dict)


class StackLightsRequest(BaseModel):
    """Calibrate, register, and stack lights into project_dir/process/result.fit
    (or process/nights/.../result.fit's merged equivalent for multi-night).

    `nights` is required — every project always uses the
    raw/nights/<name>/{lights,flats} layout (see /projects/{name}/stage
    and BuildMastersRequest), even for a project that only has one
    session; there is no separate single-night layout to remember or ask
    about. With exactly one name, that night's own sequence is
    registered/stacked directly; with two or more, they're combined first
    via Siril's `merge` (which — confirmed the hard way — refuses to run
    with fewer than two inputs, hence the split).

    Master reuse policy (per Chris, settled): `master_dark` (and
    master_bias, upstream in /masters/run) are shared across the whole
    project by default — one dark/bias set normally covers every night.
    `master_flat` is the opposite: EACH night gets its OWN master flat by
    default (process/nights/<name>/master_flat), because flats capture
    dust/vignetting that genuinely changes night to night and get retaken
    for that reason — don't default this to one shared flat "for
    simplicity." Either default can be overridden per night — see
    CalibrationOverridesRequest above — rather than uniformly for every
    selected night at once.
    """

    nights: list[str] = Field(..., min_length=1)
    stack: StackOptions = Field(default_factory=StackOptions)
    is_osc: bool = True  # False drops -cfa/-equalize_cfa/-debayer for mono cameras
    exclude_frames: list[str] = Field(default_factory=list)  # raw light frame basenames to skip (see /lights/analyze)
    drizzle: DrizzleOptions = Field(default_factory=DrizzleOptions)

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
                "stack": {"method": "winsorized", "sigma_low": 3.0, "sigma_high": 3.0},
                "is_osc": True,
                "exclude_frames": [],
            }
        }
    }


class AnalyzeLightsRequest(BaseModel):
    """Compute per-frame quality-review stats — FWHM, roundness (an
    eccentricity proxy), background, and star count — directly from raw
    light frames via astropy+photutils (app/framestats.py). No Siril, no
    masters needed; operates on raw/nights/<name>/lights directly.

    Replaced a Siril-based implementation (2026-09-2x) after finding a
    severe, confirmed performance cliff running multiple sequences in one
    Siril session (identical work: 10s alone vs 90s as the 2nd sequence).
    See Handoff.md. Note the numbers here use photutils' conventions, not
    Siril's — e.g. `roundness` is 0 for a round star and grows for
    elongated ones (Siril's own convention was the reverse: 1.0 = round).

    Nothing is excluded automatically; a human passes `exclude_frames`
    here or to /stack/run afterward. See Handoff.md for the
    astropup-blink-style "recommend, don't auto-filter" design this
    follows.
    """

    nights: list[str] = Field(..., min_length=1)
    exclude_frames: list[str] = Field(default_factory=list)  # raw light frame basenames to skip
    bin_factor: int = Field(
        default=4,
        ge=1,
        description=(
            "Block-mean downsample factor applied before detection. Higher "
            "is faster with less precision — 4 is ~11x faster than 1 "
            "(full resolution) with negligible loss for a review tool."
        ),
    )
    threshold_sigma: float = Field(
        default=8.0,
        gt=0,
        description="Star-detection threshold, in multiples of background std above the median.",
    )
    anomaly_sigma: float = Field(
        default=3.0,
        gt=0,
        description=(
            "How many standard deviations a frame's star_count/fwhm/roundness/snr must be "
            "from the rest of that night's own frames to get flagged. Lower = more sensitive "
            "(more flags, more false positives); higher = only the clearest outliers."
        ),
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "nights": ["night1"],
                "exclude_frames": [],
                "bin_factor": 4,
                "threshold_sigma": 8.0,
                "anomaly_sigma": 3.0,
            }
        }
    }


class NightSource(BaseModel):
    """One night's lights+flats to stage, as a source-folder -> internal-name
    mapping. `name` is chosen by the caller and is what actually lands on
    disk (raw/nights/<name>/...) — source folder names (e.g. "Night 1",
    with a space) never need to match any naming convention.

    `filter` handles a filter-wheel camera whose lights/flats folders mix
    several filters together (e.g. a narrowband mono session with H/O/S
    all in one "Light" folder and one "Flat" folder) — when set, only
    files whose filename matches this filter code (case-insensitive; see
    app/frameinfo.py's parse_filter()) are staged from EITHER dir, so one
    physical folder pair can back several independent sessions, one per
    filter. None stages everything in both dirs, unfiltered — the normal
    case for an OSC camera with no filter wheel at all.
    """

    name: str
    lights_dir: str  # path relative to CAPTURES_DIR, e.g. "Night 1/lights"
    flats_dir: str  # path relative to CAPTURES_DIR, e.g. "Night 1/flats"
    filter: Optional[str] = None

    model_config = {
        "json_schema_extra": {
            "example": {"name": "night1", "lights_dir": "Night 1/lights", "flats_dir": "Night 1/flats", "filter": None}
        }
    }


class StageProjectRequest(BaseModel):
    """Symlinks raw frames from CAPTURES_DIR into this project's raw/ tree
    (creating the project directory if needed). Bias/dark are shared
    (staged once, at raw/biases and raw/darks); each entry in `nights`
    stages its own lights+flats at raw/nights/<name>/{lights,flats}.
    """

    # Deliberately no default folder name (e.g. "biases") to assume — once
    # CAPTURES_DIR points at a whole, less tidily organized astrophotos
    # library rather than a dedicated per-project folder, "biases"/"darks"
    # subfolders won't reliably exist at all. None = skip staging that one.
    biases_dir: Optional[str] = None  # relative to CAPTURES_DIR
    darks_dir: Optional[str] = None  # relative to CAPTURES_DIR
    nights: list[NightSource] = Field(default_factory=list)
    is_osc: Optional[bool] = None  # None = leave any previously-recorded setting alone; see app/config.py's project meta
    # Starting point for this project's folder pickers (relative to
    # CAPTURES_DIR), set once at project creation — e.g. a target's own
    # dated capture folder, so browsing lights/flats/darks/biases doesn't
    # mean walking the whole captures tree from its root every time. A
    # starting point only, never a restriction: every picker still lets you
    # navigate anywhere else under CAPTURES_DIR via its breadcrumb. None
    # leaves any previously-recorded value alone, same as is_osc above.
    root_dir: Optional[str] = None

    model_config = {
        "json_schema_extra": {
            "example": {
                "biases_dir": "biases",
                "darks_dir": "darks",
                "nights": [
                    {"name": "night1", "lights_dir": "Night 1/lights", "flats_dir": "Night 1/flats"},
                    {"name": "night2", "lights_dir": "Night 2/lights", "flats_dir": "Night 2/flats"},
                ],
                "is_osc": True,
            }
        }
    }
