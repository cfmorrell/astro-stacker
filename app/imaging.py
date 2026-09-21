"""Renders a quick-look PNG preview from a FITS frame, for the frontend
(app/static/) — both for reviewing raw lights during /lights/analyze and
for eyeballing a finished result.fit. Not used anywhere in the actual
calibration/stacking pipeline; purely a display convenience.

Three stretch modes (Chris asked for these on the final stack preview,
matching a common astro-processing choice):
- "none": percentile-clipped linear — no curve, closest to the raw data.
- "linked": percentile + asinh stretch computed jointly across all
  channels (one black/white point for R+G+B together) — preserves
  relative color balance; the default.
- "unlinked": percentile + asinh computed separately PER channel — can
  correct color balance (each channel gets its own black/white point) at
  the cost of it no longer reflecting the true relative color.
Only "linked" vs "unlinked" differ for multi-channel (calibrated/stacked)
data; a raw single-plane Bayer sub has no channels to link or not.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.visualization import AsinhStretch, PercentileInterval
from PIL import Image

DEFAULT_MAX_SIZE = 1024
DEFAULT_STRETCH = "linked"
_STRETCH_MODES = ("none", "linked", "unlinked")

# (R, G1, B, G2) sample offsets within a 2x2 Bayer tile, keyed by the FITS
# BAYERPAT convention (top-left pixel first, reading left-to-right).
_BAYER_OFFSETS = {
    # A real, previously-undiscovered bug lived here: B and G2 were
    # transposed in every pattern (e.g. RGGB listed (1,0) as B and (1,1)
    # as G2, but the actual RGGB tile - reading the name literally,
    # row-major - is R(0,0) G(0,1) G(1,0) B(1,1), so (1,0) is a second G
    # and (1,1) is B). _debayer_block_mean's "B" output was actually
    # averaging real G with real B for its "G" channel and outputting
    # pure G for "B" - a real, structural color error, not a stretch or
    # rendering issue, present since debayering was first added. Caught
    # while chasing an unrelated checkerboard artifact: comparing the
    # demosaiced G channel against the raw mosaic's actual G1/G2 means
    # (0.586 vs 0.587 - correctly close) showed the code's own internal
    # G1/G2 split had a ~3x difference, which only makes sense if one of
    # "G1"/"G2" was actually reading true B data. Confirmed against the
    # positions by hand for all four patterns below.
    "RGGB": ((0, 0), (0, 1), (1, 1), (1, 0)),
    "BGGR": ((1, 1), (0, 1), (0, 0), (1, 0)),
    "GRBG": ((0, 1), (0, 0), (1, 0), (1, 1)),
    "GBRG": ((1, 0), (0, 0), (0, 1), (1, 1)),
}


def _convolve3x3(img: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """3x3 convolution via shifted-slice addition — avoids adding scipy as
    a dependency just for this. Edge-padded so the border pixels get a
    (slightly duplicated-edge) answer instead of shrinking the output.
    """
    h, w = img.shape
    padded = np.pad(img, 1, mode="edge")
    out = np.zeros_like(img)
    for ky in range(3):
        for kx in range(3):
            weight = kernel[ky, kx]
            if weight:
                out += weight * padded[ky : ky + h, kx : kx + w]
    return out


def _debayer_bilinear(mono: np.ndarray, pattern: str) -> np.ndarray:
    """Full-resolution bilinear Bayer demosaic — each missing sample in a
    channel is the (weighted) average of its nearest real neighbors of
    that same channel, the standard approach for a Bayer CFA. Replaces an
    earlier 2x2-block-average version that also halved resolution as a
    side effect; this is real, if not the most sophisticated (AHD etc.
    would do better at color-edge artifacts), demosaicing rather than a
    quick-look approximation. R and B sit on a lattice sampled every
    other row AND column, so each real sample's nearest same-channel
    neighbors are its 4 diagonal corners (weight 1 each) plus the 2
    orthogonal ones that fall on the same row/col of a DIFFERENT tile —
    net kernel [[1,2,1],[2,4,2],[1,2,1]]/4, verified against real Bayer
    tile positions. G sits on the other, denser checkerboard (every other
    pixel counting both row and column together): a missing G's 4
    orthogonal neighbors are always real G samples, kernel
    [[0,1,0],[1,4,1],[0,1,0]]/4. Both kernels reduce to the identity at an
    actual sample of that channel (verified: center weight 4, all other
    in-window taps land on non-that-channel positions in the sparse
    per-channel array, i.e. zero).
    """
    (ry, rx), (g1y, g1x), (by, bx), (g2y, g2x) = _BAYER_OFFSETS.get(pattern.upper(), _BAYER_OFFSETS["RGGB"])
    h, w = mono.shape
    mono = mono[: h - h % 2, : w - w % 2].astype(np.float32)
    h, w = mono.shape

    def sparse_channel(y0: int, x0: int) -> np.ndarray:
        out = np.zeros((h, w), dtype=np.float32)
        out[y0::2, x0::2] = mono[y0::2, x0::2]
        return out

    rb_kernel = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]], dtype=np.float32) / 4.0
    g_kernel = np.array([[0, 1, 0], [1, 4, 1], [0, 1, 0]], dtype=np.float32) / 4.0

    r = _convolve3x3(sparse_channel(ry, rx), rb_kernel)
    b = _convolve3x3(sparse_channel(by, bx), rb_kernel)
    g_sparse = sparse_channel(g1y, g1x)
    g_sparse[g2y::2, g2x::2] = mono[g2y::2, g2x::2]
    g = _convolve3x3(g_sparse, g_kernel)
    return np.stack([r, g, b], axis=-1)


def _block_average(arr: np.ndarray, stride: int) -> np.ndarray:
    """Downsample by averaging each stride x stride block, not by picking
    one pixel per block (rgb[::stride, ::stride]) - the latter has no
    anti-aliasing and visibly artifacts on any image with fine per-pixel
    structure. Works on both a 2D mono array and an (H, W, 3) RGB one.
    """
    if arr.ndim == 2:
        h, w = arr.shape
        h2, w2 = h - h % stride, w - w % stride
        return arr[:h2, :w2].reshape(h2 // stride, stride, w2 // stride, stride).mean(axis=(1, 3))
    h, w, c = arr.shape
    h2, w2 = h - h % stride, w - w % stride
    return arr[:h2, :w2, :].reshape(h2 // stride, stride, w2 // stride, stride, c).mean(axis=(1, 3))


def _apply_stretch(arr: np.ndarray, mode: str) -> np.ndarray:
    interval = PercentileInterval(99.5)
    if mode == "none":
        return np.clip(interval(arr), 0.0, 1.0)
    return np.clip(AsinhStretch(0.1)(interval(arr)), 0.0, 1.0)


def render_preview_png(
    path: Path,
    max_size: int = DEFAULT_MAX_SIZE,
    stretch: str = DEFAULT_STRETCH,
    debayer: bool = False,
) -> bytes:
    if stretch not in _STRETCH_MODES:
        raise ValueError(f"unknown stretch mode {stretch!r}, expected one of {_STRETCH_MODES}")

    with fits.open(path) as hdul:
        data = hdul[0].data
        header = hdul[0].header
    data = np.asarray(data, dtype=np.float32)

    if data.ndim == 3:
        # Siril stores calibrated/stacked color data channels-first
        # (3, H, W); PIL wants channels-last (H, W, 3).
        rgb = np.moveaxis(data, 0, -1)
        h, w = rgb.shape[:2]
    elif debayer:
        # Raw OSC sub, and the caller knows this is a Bayer camera (see
        # /projects/{name}/status's is_osc, set at staging time) — turn
        # the mosaic into real (if half-resolution) color instead of
        # grayscale noise. BAYERPAT is written by ASIAIR/typical capture
        # software; RGGB is the overwhelmingly common default if absent.
        pattern = str(header.get("BAYERPAT", "RGGB")).strip()
        rgb = _debayer_bilinear(data, pattern)
        h, w = rgb.shape[:2]
    else:
        # Raw OSC subs are single-plane Bayer mosaics — no color info to
        # show without debayering, so just preview it as grayscale.
        rgb = data
        h, w = rgb.shape

    # Downsample BEFORE the percentile/stretch computation, not just via
    # PIL's thumbnail() at the end — for a small review-grid thumbnail (a
    # dozen of these load at once, see app/static/), that's the
    # difference between running numpy stats over the full ~26M pixels vs
    # roughly the ~1M we actually asked to see. Confirmed this mattered in
    # practice: with 11 frame cards requesting full-resolution decodes,
    # only ~7 finished loading within 8s in the browser; this is a real
    # latency fix, not premature optimization. Fine for a quick-look
    # preview (not photometry).
    #
    # Block-AVERAGE the stride factor, not naive strided picking
    # (rgb[::stride, ::stride]): decimating without an anti-aliasing
    # filter aliases any per-pixel-scale structure into visible artifacts
    # at thumbnail size — confirmed the hard way once _debayer_bilinear
    # replaced the old block-mean debayer (which had accidentally been
    # doing this same averaging as a side effect of halving resolution).
    # Symptoms were a checkerboard/moire pattern on master flat thumbnails
    # (flats have strong fine-scale dust/vignetting texture) and a
    # turquoise color cast on review light thumbnails (color-channel
    # aliasing skewing the apparent average color). Reshaping into
    # stride x stride blocks and averaging is the standard fix and isn't
    # meaningfully slower than the naive version.
    stride = max(1, -(-max(h, w) // max_size)) if max_size else 1
    if stride > 1:
        rgb = _block_average(rgb, stride)

    if rgb.ndim == 3 and stretch == "unlinked":
        # Per-channel: each gets its own percentile+asinh curve, i.e. its
        # own black/white point — "linked" is what _apply_stretch(..,
        # "linked") does to a single channel too, just called once per
        # channel here instead of once across all of them jointly.
        normed = np.stack([_apply_stretch(rgb[..., c], "linked") for c in range(rgb.shape[-1])], axis=-1)
    else:
        normed = _apply_stretch(rgb, stretch)
    img8 = (normed * 255).astype(np.uint8)

    image = Image.fromarray(img8)
    if image.width > max_size or image.height > max_size:
        image.thumbnail((max_size, max_size))

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
