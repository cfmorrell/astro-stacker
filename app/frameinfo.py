"""Infers frame metadata (type, exposure) from capture filenames.

Most capture software (ASIAIR, N.I.N.A., etc.) puts both right in the
name, e.g. "Light_ElephantTrunk_300.0s_Bin1_2600MC_gain100_...fit" or
"Dark_300.0s_Bin1_2600MC_gain100_...fit" — cheap to check without opening
any FITS headers, matching this app's existing filename-based approach
(see the frame-type/lights-flats mismatch warnings at Stage time).
"""

from __future__ import annotations

import re

_FRAME_TYPE_KEYWORDS = ("light", "dark", "flat", "bias")

# e.g. "_300.0s_" or "_1.0ms_" -> 300.0 seconds / 0.001 seconds.
_EXPOSURE_RE = re.compile(r"_(\d+(?:\.\d+)?)(ms|s)_", re.IGNORECASE)

# A filter-wheel camera's filenames put the filter code right before
# "_gain<N>_" (e.g. "..._2600MM_H_gain100_...", "..._2600MM_O_gain100_...")
# — an OSC camera's own filenames have nothing there at all
# ("..._2600MC_gain100_...", camera model directly adjacent to gain), so
# this naturally returns no match for OSC data rather than a false filter.
_FILTER_RE = re.compile(r"_([A-Za-z]{1,6})_gain\d+_")


def _dominant(counts: dict, total: int):
    """Shared "does >=90% of the evidence agree" rule used by both
    detectors below: returns the dominant key, or None if there's no
    evidence at all (nothing to warn about — "can't tell" isn't "wrong").
    Ambiguous (no single key over the threshold) is left for the caller
    to represent however fits ("mixed" for type, None for exposure).
    """
    if total == 0:
        return None
    key, count = max(counts.items(), key=lambda kv: kv[1])
    return key if count / total >= 0.9 else None


def detect_frame_type(filenames: list[str]) -> str | None:
    """Guess what kind of frames a directory holds by checking each
    filename (case-insensitive) for one of the standard type keywords.

    Returns the dominant type if at least 90% of files that mention ANY
    keyword agree on which one; "mixed" if they don't (inconsistent
    naming — still worth a warning); None if no file mentions a keyword
    at all, since that's "we can't tell," not "this looks wrong."
    """
    counts = {k: 0 for k in _FRAME_TYPE_KEYWORDS}
    for name in filenames:
        lower = name.lower()
        matched = [k for k in _FRAME_TYPE_KEYWORDS if k in lower]
        if len(matched) == 1:
            counts[matched[0]] += 1
    total = sum(counts.values())
    if total == 0:
        return None
    dominant = _dominant(counts, total)
    return dominant if dominant is not None else "mixed"


def parse_exposure_seconds(filename: str) -> float | None:
    """Extract one frame's exposure length from its filename, in seconds.
    None if the filename doesn't match the standard "_<number><s|ms>_"
    pattern at all (unusual capture software naming — not treated as an
    error by callers, just "unknown").
    """
    m = _EXPOSURE_RE.search(filename)
    if not m:
        return None
    value = float(m.group(1))
    return value / 1000.0 if m.group(2).lower() == "ms" else value


def detect_exposure_seconds(filenames: list[str]) -> float | None:
    """Dominant exposure time across a set of filenames (rounded to 3
    decimal places before grouping, so float formatting quirks in the
    source filenames themselves can't split one real exposure length into
    two buckets). None if fewer than 90% of parseable filenames agree, or
    if no filename was parseable at all — "can't tell," not "mismatched."
    """
    counts: dict[float, int] = {}
    total = 0
    for name in filenames:
        seconds = parse_exposure_seconds(name)
        if seconds is None:
            continue
        key = round(seconds, 3)
        counts[key] = counts.get(key, 0) + 1
        total += 1
    return _dominant(counts, total)


def parse_filter(filename: str) -> str | None:
    """This one frame's filter code (e.g. "H", "O", "S", "L", "R"), None
    if the filename doesn't match a filter-wheel camera's naming pattern
    at all (OSC cameras have no filter wheel — that's the expected,
    correct result for them, not a failure).
    """
    m = _FILTER_RE.search(filename)
    return m.group(1).upper() if m else None


def detect_filters(filenames: list[str]) -> list[str]:
    """Every distinct filter code found across a set of filenames, sorted
    alphabetically (e.g. ["H", "O", "S"] for a mixed narrowband folder).
    Empty if none of them match the filter-wheel naming pattern at all.
    Unlike detect_frame_type()/detect_exposure_seconds(), this ISN'T
    trying to find one dominant answer — a folder full of DIFFERENT
    filters mixed together is the normal, expected case this exists to
    surface (see /captures/browse's detected_filters and Stage's
    per-session filter picker), not something to average away.
    """
    return sorted({parse_filter(name) for name in filenames} - {None})


def count_filters(filenames: list[str]) -> dict[str, int]:
    """How many filenames matched each filter code (e.g. {"H": 15, "O":
    14, "S": 16}) - same filter codes as detect_filters(), but with the
    per-filter frame count Stage's filter picker shows next to each one
    so Chris can tell at a glance whether e.g. one filter is short a few
    subs before staging, not just which filters are present.
    """
    counts: dict[str, int] = {}
    for name in filenames:
        f = parse_filter(name)
        if f is not None:
            counts[f] = counts.get(f, 0) + 1
    return counts


def detect_exposures(filenames: list[str]) -> list[float]:
    """Every distinct exposure length found across a set of filenames
    (rounded to 3 decimal places, same convention as
    detect_exposure_seconds()), sorted ascending - e.g. [60.0, 300.0] for
    an OSC folder mixing two sub lengths. Empty if no filename parsed.
    Same "surface every value, don't average away a genuine mix"
    philosophy as detect_filters() - this exists specifically to let
    Stage's picker split an OSC session into one row per exposure length,
    the same way a mixed-filter folder already splits into one row per
    filter.
    """
    return sorted({round(s, 3) for name in filenames if (s := parse_exposure_seconds(name)) is not None})


def count_exposures(filenames: list[str]) -> dict[float, int]:
    """How many filenames matched each exposure length (e.g. {60.0: 12,
    300.0: 8}) - same exposure values as detect_exposures(), but with the
    per-exposure frame count, mirroring count_filters().
    """
    counts: dict[float, int] = {}
    for name in filenames:
        s = parse_exposure_seconds(name)
        if s is not None:
            key = round(s, 3)
            counts[key] = counts.get(key, 0) + 1
    return counts


def detect_exposure_by_filter(filenames: list[str]) -> dict[str, float | None]:
    """Each detected filter's OWN dominant exposure length, computed
    independently per filter rather than across the whole mixed folder at
    once - a REAL bug this fixes: a folder mixing filters that
    legitimately use DIFFERENT exposures (e.g. narrowband H/O/S at 300s,
    L at 180s in the same "Light" folder) can easily have no single
    dominant exposure across ALL files combined (confirmed on real data:
    300s covered 59/69 = 85.5% of files, just under detect_exposure_
    seconds()'s 90% threshold), even though each individual filter's own
    subset is perfectly unambiguous (H/O/S are each 100% 300s; L is 100%
    180s). Without this, a filter-locked group falls back to
    detect_exposure_seconds()'s ambiguous (None) whole-folder answer,
    which broke the darks/lights exposure-mismatch warning, the darks
    cross-row auto-fill (both keyed on "this group's own light
    exposure"), and the frame-count summary's exposure display - all
    three confirmed as one root cause, not three separate bugs.
    """
    by_filter: dict[str, list[str]] = {}
    for name in filenames:
        f = parse_filter(name)
        if f is not None:
            by_filter.setdefault(f, []).append(name)
    return {f: detect_exposure_seconds(names) for f, names in by_filter.items()}
