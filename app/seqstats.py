"""Parses per-frame registration/quality stats out of Siril .seq files.

Siril's own `register` command computes exactly the metrics the Endstate
asks for (FWHM, star count, "eccentricity" via roundness, background) as
part of ordinary registration — see Handoff.md's frame-review notes. This
deliberately avoids reimplementing star detection/PSF fitting: we just
read what Siril already computed and wrote to disk.

.seq registration-data line format (reverse-engineered from real output —
see a completed job's process/*_.seq file — and cross-checked against
Siril's own `seqapplyreg` command, whose documented filter flags
-filter-fwhm/-filter-wfwhm/-filter-round/-filter-quality/-filter-bkg/
-filter-nbstars match this column order 1:1):

    R<layer> fwhm wfwhm roundness quality background nb_stars <ref_idx> H ...

`quality` has read 0 for every frame in every run tested so far — it
appears unpopulated by Siril's default (non-planetary) star-alignment
registration method rather than genuinely being zero; treat it as
possibly-meaningless until proven otherwise on this camera/method.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

_FIT_SUFFIXES = {".fit", ".fits"}


@dataclass
class FrameStats:
    index: int  # 1-based position within this layer's stats, in file order
    layer: int
    filename: str | None  # best-effort match to a raw source file; see note below
    fwhm: float
    weighted_fwhm: float
    roundness: float  # Siril's own term; the eccentricity proxy Chris asked for (1.0 = round, lower = elongated)
    quality: float
    background: float
    star_count: int


def parse_registration_stats(seq_path: Path, source_dir: Path | None = None) -> list[FrameStats]:
    """Parse every `R<layer> ...` line in a .seq file into FrameStats, in
    file order.

    If given, `source_dir` is used to recover the original filename for
    each frame: Siril's `convert` processes a directory's *.fit/*.fits
    files in alpha-sorted order and numbers the output sequence 1, 2, 3...
    in that same order (confirmed against test-run logs), so the Nth
    alpha-sorted file in source_dir is frame N. If source_dir is omitted,
    or its file count doesn't match, `filename` is left None rather than
    guessed at.
    """
    if not seq_path.is_file():
        raise FileNotFoundError(f"sequence file not found: {seq_path}")

    filenames: list[str] = []
    if source_dir is not None and source_dir.is_dir():
        filenames = [
            p.name for p in sorted(source_dir.iterdir()) if p.suffix.lower() in _FIT_SUFFIXES
        ]

    stats: list[FrameStats] = []
    counters: dict[int, int] = {}
    for line in seq_path.read_text().splitlines():
        if not line.startswith("R"):
            continue
        parts = line.split()
        tag = parts[0]  # e.g. "R1"
        if not tag[1:].isdigit():
            continue
        layer = int(tag[1:])
        try:
            fwhm, wfwhm, roundness, quality, background = (float(x) for x in parts[1:6])
            star_count = int(float(parts[6]))
        except (ValueError, IndexError):
            continue  # not a stats line we recognize; skip rather than crash the whole parse

        counters[layer] = counters.get(layer, 0) + 1
        idx = counters[layer]
        filename = filenames[idx - 1] if 0 < idx <= len(filenames) else None

        stats.append(
            FrameStats(
                index=idx,
                layer=layer,
                filename=filename,
                fwhm=fwhm,
                weighted_fwhm=wfwhm,
                roundness=roundness,
                quality=quality,
                background=background,
                star_count=star_count,
            )
        )
    return stats


def stats_to_dicts(stats: list[FrameStats]) -> list[dict]:
    return [asdict(s) for s in stats]
