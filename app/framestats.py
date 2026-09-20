"""Per-light-frame quality metrics via astropy + photutils.

Replaces Siril for /lights/analyze (2026-09-2x). Why: Siril's calibrate+
register writes a full ~300MB registered .fit per frame we never needed
just for review numbers, and running multiple sequences in one Siril
session has a severe, confirmed performance cliff — identical
calibrate+register work took 10s alone vs 90s as the second sequence in
one session (Siril doesn't cleanly release memory/thread state between
sequence operations; see Handoff.md gotcha #8). This module is stateless
numpy/astropy work per frame, called directly from Python — no
subprocess, so that failure mode can't happen here, and it's faster
besides (benchmarked against real capture data: ~0.3s/frame at 4x binning
vs Siril's ~0.7-1s/frame even in Siril's *best* case, which still also
writes a needless registered image).

Operates directly on RAW, uncalibrated light frames — no masters needed,
Siril never invoked. This is deliberately a fast quality *review* tool
(FWHM/roundness/star-count/background/SNR for a human to eyeball, matching
Chris's "recommend, don't auto-filter" requirement), not calibrated
photometry. Trade-offs made for speed, fine for that purpose:
- Block-mean binned (default 4x4) before detection/background — ~11x
  faster than full resolution, benchmarked on a real 6248x4176 OSC frame.
  For a Bayer/OSC sensor, a bin factor that's a multiple of 2 naturally
  averages across each RGGB tile, acting as a rough luminance/debayer
  step for free — no separate debayering needed. (Already-debayered
  multi-layer input, e.g. a calibrated frame, is also handled below.)
- No dark/bias subtraction: the reported background level includes the
  uncorrected dark+bias offset. Fine for comparing frames *within one
  session* (same camera/gain/temp, same offset on every frame), not a
  true sky background. FWHM/roundness (star shape) are barely affected.
- Defaults (bin_factor=4, threshold_sigma=8.0) validated 2026-09-2x
  against real two-night data with known-bad frames (a twilight-ramp
  session tail and an early elevated-background frame — see
  flag_anomalies() below): produced a clean, well-separated signal
  without further tuning. Worth revisiting once there's more than one
  target's worth of data to check against.

Star-detection API notes (photutils 3.0, confirmed empirically against
real capture data, not just docs): IRAFStarFinder (not DAOStarFinder) is
used because it returns `fwhm` and `roundness` directly per source in one
pass — DAOStarFinder's table has no fwhm column. Its `roundness` is 0 for
a round source and grows for elongated ones (unlike Siril's own
convention, where 1.0 = round — these numbers are NOT directly comparable
to Siril's, by design; see AnalyzeLightsRequest's docstring).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from photutils.detection import IRAFStarFinder

DEFAULT_BIN_FACTOR = 4
DEFAULT_THRESHOLD_SIGMA = 8.0  # multiples of background std, above the median

# Anomaly flagging (see flag_anomalies()): a robust z-score magnitude
# above this, on ANY one metric, flags the frame. 3.0 is a conventional
# "notably unusual" cutoff for a MAD-based robust z-score; picked to
# clearly catch a real 7-frame twilight ramp in test data (z-scores in
# the tens) without needing per-target tuning. Flagging errs toward
# over-sensitive, not under: this recommends for human review, it
# doesn't decide anything (see AnalyzeLightsRequest's docstring).
ANOMALY_Z_THRESHOLD = 3.0
_FLAGGABLE_METRICS = ("star_count", "fwhm", "roundness", "snr")

_FIT_SUFFIXES = {".fit", ".fits"}


@dataclass
class FrameStats:
    filename: str
    fwhm: Optional[float]  # median FWHM across detected stars, in ORIGINAL-frame pixels
    roundness: Optional[float]  # median roundness (0 = round, higher = more elongated)
    star_count: int
    background: float  # median background level, raw ADU (uncalibrated — see module docstring)
    background_std: float
    snr: Optional[float] = None  # median star flux / background_std — relative, not calibrated
    captured_at: Optional[str] = None  # FITS DATE-OBS (UTC), for chronological display/sort
    anomaly_z: dict = field(default_factory=dict)  # per-metric robust z-score vs. the rest of this night
    flagged: bool = False  # True if any metric's |z| >= ANOMALY_Z_THRESHOLD — a recommendation, not a decision


@dataclass
class NightTarget:
    key: str
    lights_dir: Path
    files: list[Path]  # sorted, already excluding any names in exclude_frames


def resolve_analyze_targets(
    project: Path, nights: list[str], exclude_frames: list[str]
) -> list[NightTarget]:
    """Resolve each requested night to its (already-filtered) list of raw
    light frames. Raises ValueError (-> HTTP 400 in main.py) for a bad
    night name or a missing lights directory — same validate-before-doing-
    anything approach as ssf.py's _resolve_nights, for the same reason
    (see Handoff.md on the 'string' placeholder and dual-layout incidents).
    """
    exclude = set(exclude_frames)
    targets: list[NightTarget] = []
    for name in nights:
        if not name or "/" in name or name in (".", ".."):
            raise ValueError(f"invalid night name: {name!r}")
        lights_dir = project / "raw" / "nights" / name / "lights"
        if not lights_dir.is_dir():
            raise ValueError(f"lights directory not found: {str(lights_dir)!r}")
        files = sorted(
            p
            for p in lights_dir.iterdir()
            if p.suffix.lower() in _FIT_SUFFIXES and p.name not in exclude
        )
        targets.append(NightTarget(key=name, lights_dir=lights_dir, files=files))
    return targets


def _bin_mean(a: np.ndarray, k: int) -> np.ndarray:
    """Block-mean downsample by k in both axes (drops any remainder rows/cols)."""
    if k <= 1:
        return a
    h, w = a.shape
    h2, w2 = h - h % k, w - w % k
    a = a[:h2, :w2]
    return a.reshape(h2 // k, k, w2 // k, k).mean(axis=(1, 3))


def analyze_frame(
    path: Path,
    bin_factor: int = DEFAULT_BIN_FACTOR,
    threshold_sigma: float = DEFAULT_THRESHOLD_SIGMA,
) -> FrameStats:
    """Compute quality-review stats for a single light frame."""
    with fits.open(path) as hdul:
        data = hdul[0].data
        captured_at = hdul[0].header.get("DATE-OBS")
    data = np.asarray(data, dtype=np.float32)
    if data.ndim == 3:
        # Already-debayered multi-layer data (e.g. a calibrated frame) —
        # green carries the most signal/detail for an RGGB OSC sensor.
        data = data[1]

    binned = _bin_mean(data, bin_factor)
    _mean, median, std = sigma_clipped_stats(binned, sigma=3.0, maxiters=3)

    finder = IRAFStarFinder(
        threshold=median + threshold_sigma * std,
        fwhm=max(3.0 / bin_factor, 2.0),
        sharpness_range=(0.3, 2.0),
        roundness_range=(-1.0, 1.0),
    )
    sources = finder(binned - median)

    if sources is None or len(sources) == 0:
        return FrameStats(
            filename=path.name,
            fwhm=None,
            roundness=None,
            star_count=0,
            background=float(median),
            background_std=float(std),
            snr=None,
            captured_at=captured_at,
        )

    snr = float(np.median(sources["flux"])) / float(std) if std > 0 else None
    return FrameStats(
        filename=path.name,
        # Scaled back up to original-frame pixels so the number means the
        # same thing regardless of bin_factor.
        fwhm=float(np.median(sources["fwhm"])) * bin_factor,
        roundness=float(np.median(sources["roundness"])),
        star_count=len(sources),
        background=float(median),
        background_std=float(std),
        snr=snr,
        captured_at=captured_at,
    )


def _robust_z_scores(values: list[float]) -> list[float]:
    """Median-absolute-deviation-based z-scores: robust to the outliers
    themselves skewing the baseline, unlike a plain mean/stdev z-score
    (a handful of badly-off frames would otherwise inflate the stdev and
    mask themselves). Returns all zeros if every value is identical.
    """
    arr = np.asarray(values, dtype=np.float64)
    median = float(np.median(arr))
    mad = float(np.median(np.abs(arr - median)))
    if mad == 0:
        return [0.0] * len(values)
    scaled_mad = mad * 1.4826  # normal-distribution consistency constant
    return list(np.abs(arr - median) / scaled_mad)


def flag_anomalies(frames: list[FrameStats], z_threshold: float = ANOMALY_Z_THRESHOLD) -> None:
    """Flag frames whose metrics deviate unusually far from the REST OF
    THIS NIGHT's own median — per Chris: "the key is looking for
    anomalies in the data, not fixating on particular numbers as
    cutoffs" — matching astropup-blink's per-metric outlier presentation
    against a sequence's own distribution rather than a fixed absolute
    threshold. Mutates each FrameStats' .anomaly_z/.flagged in place.

    Call this once per night (frames from one imaging session) — mixing
    nights with different sky conditions/exposure/gear into one baseline
    would bury real within-night anomalies under between-night variation.

    Validated against real data (2026-09-2x): correctly flagged all 7
    frames of a genuine dawn-twilight ramp (background 635->8756 ADU,
    star count 368->18, star_count/background/snr z-scores in the tens)
    without any manual tuning.
    """
    if len(frames) < 3:
        # Not enough frames for a meaningful "deviates from the rest"
        # judgment; leave everything unflagged rather than guess.
        for f in frames:
            f.anomaly_z = {}
            f.flagged = False
        return

    for metric in _FLAGGABLE_METRICS:
        indices = [i for i, f in enumerate(frames) if getattr(f, metric) is not None]
        if len(indices) < 3:
            continue
        z_scores = _robust_z_scores([getattr(frames[i], metric) for i in indices])
        for idx, z in zip(indices, z_scores):
            frames[idx].anomaly_z[metric] = round(float(z), 2)

    for f in frames:
        # Zero detections is its own unambiguous anomaly (nothing to
        # compute a z-score against) — flag directly rather than putting
        # a non-JSON-safe infinity in anomaly_z.
        f.flagged = f.star_count == 0 or any(z >= z_threshold for z in f.anomaly_z.values())
