"""Reads a representative FITS header from a directory of capture frames.

Complements app/frameinfo.py (filename-only inference) with header-based
facts filenames can't carry: which physical camera shot a frame
(INSTRUME) and exactly when (DATE-OBS). Backs two real-mistake warnings
at Stage time — calibration frames shot with a different camera than the
lights they're meant to correct, and calibration frames whose capture
date is too far from the lights' own session to still be valid (flats
correct dust/vignetting that changes session to session; darks/bias
drift with sensor age and ambient conditions over longer spans).

Deliberately reads only ONE file per directory (the first that opens
cleanly), not every frame - frames within a single capture session are
shot within minutes of each other on the same camera, so one sample is
representative, and this needs to stay cheap enough to run on every
folder pick in the Stage UI, unlike a full per-file scan.
"""

from __future__ import annotations

from pathlib import Path

from astropy.io import fits

_FIT_SUFFIXES = (".fit", ".fits")
_MAX_ATTEMPTS = 5  # tolerate a few corrupt/unreadable files before giving up


def read_sample_fits_info(directory: Path) -> dict:
    """{"date_obs": str|None, "instrument": str|None} from the first FITS
    file in `directory` whose header can actually be read. Both None if
    the directory has no FITS files, or none of the first few open
    cleanly - "can't tell," not an error, matching this app's other
    filename-based detectors.
    """
    attempts = 0
    for path in sorted(directory.iterdir()):
        if path.suffix.lower() not in _FIT_SUFFIXES:
            continue
        attempts += 1
        if attempts > _MAX_ATTEMPTS:
            break
        try:
            header = fits.getheader(path)
        except Exception:
            continue
        return {"date_obs": header.get("DATE-OBS"), "instrument": header.get("INSTRUME")}
    return {"date_obs": None, "instrument": None}
