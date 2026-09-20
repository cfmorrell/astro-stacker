"""Per-light-frame quality metrics via astropy + photutils.

Replaces Siril for /lights/analyze (2026-09-2x). Why: Siril's calibrate+
register writes a full ~300MB registered .fit per frame we never needed
just for review numbers, and running multiple sequences in one Siril
session has a severe, confirmed performance cliff — identical
calibrate+register work took 10s alone vs 90s as the second sequence in
one session (Siril doesn't cleanly release memory/thread state between
sequence operations; see Handoff.md gotcha on this). This module is
stateless numpy/astropy work per frame, called directly from Python — no
subprocess, so that failure mode can't happen here, and it's faster
besides (benchmarked against real capture data: ~0.3s/frame at 4x binning
vs Siril's ~0.7-1s/frame even in Siril's *best* case, which still also
writes a needless registered image).

Operates directly on RAW, uncalibrated light frames — no masters needed,
Siril never invoked. This is deliberately a fast quality *review* tool
(FWHM/roundness/star-count/background for a human to eyeball, matching
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

Star-detection API notes (photutils 3.0, confirmed empirically against
real capture data, not just docs): IRAFStarFinder (not DAOStarFinder) is
used because it returns `fwhm` and `roundness` directly per source in one
pass — DAOStarFinder's table has no fwhm column. Its `roundness` is 0 for
a round source and grows for elongated ones (unlike Siril's own
convention, where 1.0 = round — these numbers are NOT directly comparable
to Siril's, by design; see AnalyzeLightsRequest's docstring).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from photutils.detection import IRAFStarFinder

DEFAULT_BIN_FACTOR = 4
DEFAULT_THRESHOLD_SIGMA = 8.0  # multiples of background std, above the median

_FIT_SUFFIXES = {".fit", ".fits"}


@dataclass
class FrameStats:
    filename: str
    fwhm: Optional[float]  # median FWHM across detected stars, in ORIGINAL-frame pixels
    roundness: Optional[float]  # median roundness (0 = round, higher = more elongated)
    star_count: int
    background: float  # median background level, raw ADU (uncalibrated — see module docstring)
    background_std: float


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
        )

    return FrameStats(
        filename=path.name,
        # Scaled back up to original-frame pixels so the number means the
        # same thing regardless of bin_factor.
        fwhm=float(np.median(sources["fwhm"])) * bin_factor,
        roundness=float(np.median(sources["roundness"])),
        star_count=len(sources),
        background=float(median),
        background_std=float(std),
    )
