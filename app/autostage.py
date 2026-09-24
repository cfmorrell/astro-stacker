"""Best-effort auto-detection of a staging plan from a root folder - lets
Chris pick one folder when creating a project and get a pre-populated set
of session (lights + flats) and darks/biases candidates to review and
adjust, instead of clicking through the folder picker once per field by
hand.

Deliberately conservative about what it's willing to guess:
- Every candidate comes from INSIDE the chosen root only - this never
  searches the wider captures library, so it can never propose something
  from an unrelated project sitting elsewhere in CAPTURES_DIR.
- A flats/darks folder is only ever paired with a lights folder via one of
  three structural rules, in priority order (see _pair_dir()): nested
  directly inside the lights folder, a SIBLING of it (same parent
  directory - e.g. "Night 1/{Light,Flat,Dark}"), or a normalized-path
  match where only a frame-type keyword differs (e.g.
  "Project/Light/H" <-> "Project/Dark/H", where the parents differ but
  everything else about the path lines up). Never guessed across folders
  that happen to both look like the right type but come from different
  sessions with no structural relationship at all. Chris asked for
  exactly this kind of caution ("not do it if project names/folder
  names/file names aren't at least similar because they clearly apply to
  different projects") - confining every candidate to the explicitly-
  chosen root, plus these three structural rules, delivers that without
  needing a separate fuzzy-name-similarity heuristic: there is no
  cross-project ambiguity left to guard against once nothing outside the
  chosen folder is ever considered.
- A flats/darks candidate that doesn't structurally match ANY session
  still gets one last chance: if it's the ONLY candidate of its type left
  over project-wide once every structural match has been made, it's
  proposed for every session still missing one (e.g. one shared darks
  folder for an otherwise flat-per-session project). Two or more leftover
  candidates is genuinely ambiguous, so it's left blank rather than
  guessing wrong. biases_dir (singular, project-wide - see
  scan_for_staging_plan()'s return) uses this same "exactly one
  candidate anywhere" rule directly, with no per-session fan-out, since
  biases are never per-session.
- A bounded depth and a cap on how many folders get inspected keep this
  fast and safe against a pathologically deep or wide tree.
"""

from __future__ import annotations

from pathlib import Path

from . import frameinfo

MAX_DEPTH = 3
MAX_FOLDERS_CHECKED = 200

_FIT_SUFFIXES = (".fit", ".fits")

# Folder-name keywords normalized away when comparing two paths' shapes -
# see _normalize_parts(). Covers both singular and plural spellings since
# real capture software uses both ("Light" vs "Lights").
_FRAME_TYPE_DIR_NAMES = {"light", "lights", "dark", "darks", "flat", "flats", "bias", "biases"}


def _classify_dir(path: Path) -> str | None:
    """The dominant frame type of this directory's own direct contents
    (not recursive) - the SAME 90%-agreement detection used everywhere
    else in this app (frameinfo.py) for Stage-time warnings, so a folder
    only counts as a candidate here if that same rule already trusts it.
    None for an empty folder, or one with no confident majority (e.g.
    "mixed" - not useful as an auto-staging candidate either way).
    """
    try:
        names = [p.name for pat in _FIT_SUFFIXES for p in path.glob(f"*{pat}")]
    except OSError:
        return None
    if not names:
        return None
    kind = frameinfo.detect_frame_type(names)
    return kind if kind in ("light", "flat", "dark", "bias") else None


def _normalize_parts(path: Path, root: Path) -> tuple[str, ...]:
    """path's components relative to root, lowercased, with any frame-type
    keyword (light/dark/flat/bias, singular or plural) replaced by a
    shared placeholder - lets two parallel branches like
    "Project/Light/H" and "Project/Dark/H" compare equal on everything
    BUT the one segment that's supposed to differ (see _pair_dir()'s
    normalized-path rule).
    """
    return tuple("*" if p.lower() in _FRAME_TYPE_DIR_NAMES else p.lower() for p in path.relative_to(root).parts)


def _pair_dir(light_dir: Path, candidates: list[Path], captures_root: Path) -> Path | None:
    """Best structural match for light_dir among candidates (a session's
    flat_dirs or dark_dirs), tried in priority order - see this module's
    docstring for what each rule catches. None if nothing structurally
    lines up; the caller applies one further fallback (the single-
    leftover-candidate rule) across every still-unmatched session at once,
    not per light_dir, since it needs to see the whole picture first.
    """
    nested = next((c for c in candidates if c.parent == light_dir), None)
    if nested is not None:
        return nested
    sibling = next((c for c in candidates if c.parent == light_dir.parent), None)
    if sibling is not None:
        return sibling
    light_key = _normalize_parts(light_dir, captures_root)
    return next((c for c in candidates if _normalize_parts(c, captures_root) == light_key), None)


def _apply_leftover_fallback(sessions: list[dict], key: str, candidates: list[Path], captures_root: Path) -> None:
    """If exactly one candidate wasn't already matched to any session by
    _pair_dir()'s structural rules, propose it for every session still
    missing one under `key` - generalizes the old "exactly one candidate
    anywhere" rule (still used as-is for biases_dir below, which has no
    per-session concept at all) to fan out across sessions instead of
    filling a single shared field. Two or more leftover candidates is
    genuinely ambiguous, so nothing here is touched.
    """
    matched = {s[key] for s in sessions if s[key] is not None}
    leftover = [c for c in candidates if str(c.relative_to(captures_root)) not in matched]
    if len(leftover) != 1:
        return
    fallback = str(leftover[0].relative_to(captures_root))
    for session in sessions:
        if session[key] is None:
            session[key] = fallback


def scan_for_staging_plan(captures_root: Path, start: Path) -> dict:
    """Walks `start` (already resolved/validated to be captures_root or
    somewhere under it) up to MAX_DEPTH levels looking for light/flat/
    dark/bias folders, and proposes a staging plan. All paths returned
    are relative to captures_root, ready to hand straight to
    StageProjectRequest/NightSource. `truncated` is True if the folder
    cap was hit, meaning there could be more out there this didn't see.
    """
    light_dirs: list[Path] = []
    flat_dirs: list[Path] = []
    dark_dirs: list[Path] = []
    bias_dirs: list[Path] = []
    checked = 0
    truncated = False

    def walk(d: Path, depth: int) -> None:
        nonlocal checked, truncated
        if checked >= MAX_FOLDERS_CHECKED:
            truncated = True
            return
        checked += 1
        kind = _classify_dir(d)
        if kind == "light":
            light_dirs.append(d)
        elif kind == "flat":
            flat_dirs.append(d)
        elif kind == "dark":
            dark_dirs.append(d)
        elif kind == "bias":
            bias_dirs.append(d)
        if depth >= MAX_DEPTH:
            return
        # Recurse regardless of whether this dir itself classified as
        # something - in every real layout seen so far a lights/flats
        # folder is a leaf, never itself a parent of more lights/flats,
        # but nothing here depends on that being true.
        try:
            subdirs = sorted(p for p in d.iterdir() if p.is_dir())
        except OSError:
            return
        for sub in subdirs:
            walk(sub, depth + 1)

    walk(start, 0)

    sessions = []
    for light_dir in light_dirs:
        flat_match = _pair_dir(light_dir, flat_dirs, captures_root)
        dark_match = _pair_dir(light_dir, dark_dirs, captures_root)
        sessions.append(
            {
                "lights_dir": str(light_dir.relative_to(captures_root)),
                "flats_dir": str(flat_match.relative_to(captures_root)) if flat_match else None,
                "darks_dir": str(dark_match.relative_to(captures_root)) if dark_match else None,
            }
        )
    _apply_leftover_fallback(sessions, "flats_dir", flat_dirs, captures_root)
    _apply_leftover_fallback(sessions, "darks_dir", dark_dirs, captures_root)

    return {
        "sessions": sessions,
        "biases_dir": str(bias_dirs[0].relative_to(captures_root)) if len(bias_dirs) == 1 else None,
        "truncated": truncated,
    }
