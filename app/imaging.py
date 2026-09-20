"""Renders a quick-look PNG preview from a FITS frame, for the frontend
(app/static/) — both for reviewing raw lights during /lights/analyze and
for eyeballing a finished result.fit. Not used anywhere in the actual
calibration/stacking pipeline; purely a display convenience.

Uses a simple percentile-clip + asinh stretch (the standard astropy
approach for a quick linear-to-visual preview) — good enough to tell a
good frame from a bad one at a glance, not a substitute for real
post-processing (stretch/color work happens elsewhere, per Handoff.md).
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.visualization import AsinhStretch, PercentileInterval
from PIL import Image

DEFAULT_MAX_SIZE = 1024


def render_preview_png(path: Path, max_size: int = DEFAULT_MAX_SIZE) -> bytes:
    with fits.open(path) as hdul:
        data = hdul[0].data
    data = np.asarray(data, dtype=np.float32)

    if data.ndim == 3:
        # Siril stores calibrated/stacked color data channels-first
        # (3, H, W); PIL wants channels-last (H, W, 3).
        rgb = np.moveaxis(data, 0, -1)
        h, w = rgb.shape[:2]
    else:
        # Raw OSC subs are single-plane Bayer mosaics — no color info to
        # show without debayering, so just preview it as grayscale.
        rgb = data
        h, w = rgb.shape

    # Downsample via simple striding BEFORE the percentile/stretch
    # computation, not just via PIL's thumbnail() at the end — for a
    # small review-grid thumbnail (a dozen of these load at once, see
    # app/static/), that's the difference between running numpy stats
    # over the full ~26M pixels vs roughly the ~1M we actually asked to
    # see. Confirmed this mattered in practice: with 11 frame cards
    # requesting full-resolution decodes, only ~7 finished loading within
    # 8s in the browser; this is a real latency fix, not premature
    # optimization. Fine for a quick-look preview (not photometry).
    stride = max(1, -(-max(h, w) // max_size)) if max_size else 1
    if stride > 1:
        rgb = rgb[::stride, ::stride] if rgb.ndim == 2 else rgb[::stride, ::stride, :]

    interval = PercentileInterval(99.5)
    stretch = AsinhStretch(0.1)
    normed = np.clip(stretch(interval(rgb)), 0.0, 1.0)
    img8 = (normed * 255).astype(np.uint8)

    image = Image.fromarray(img8)
    if image.width > max_size or image.height > max_size:
        image.thumbnail((max_size, max_size))

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
