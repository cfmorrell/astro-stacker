"""FastAPI app: render .ssf scripts (dry-run) or run them as background jobs.

Also serves the first-version frontend (app/static/, mounted at the very
end of this file) — a plain HTML/CSS/JS page with no build step, styled
after astrolab's dark card-based UI but scoped to this project's own
functionality (stage -> masters -> analyze/review -> stack), closer in
spirit to Siril's own OSC Multi-Night Stacking tool. See Handoff.md.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config, fitsinfo, frameinfo, framestats, imaging, jobs, ssf, staging, status
from .models import (
    AnalyzeLightsRequest,
    BuildMastersRequest,
    CalibrationOverridesRequest,
    StackLightsRequest,
    StageProjectRequest,
)

app = FastAPI(title="astro-stacker")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def _project_path(name: str) -> Path:
    try:
        return config.project_dir(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _project_or_404(name: str) -> Path:
    project = _project_path(name)
    if not project.is_dir():
        raise HTTPException(status_code=404, detail=f"unknown project {name!r}")
    return project


@app.get("/health")
def health():
    return {"status": "ok", "siril_bin": config.SIRIL_BIN, "projects_dir": str(config.PROJECTS_DIR)}


@app.get("/projects")
def list_projects():
    if not config.PROJECTS_DIR.is_dir():
        return {"projects": []}
    return {"projects": sorted(p.name for p in config.PROJECTS_DIR.iterdir() if p.is_dir())}


@app.delete("/projects/{name}")
def delete_project(name: str):
    """Permanently remove a project's entire directory — staged raw/
    symlinks, built masters, review data, and any stacked result. Safe to
    call even though raw/ is full of symlinks into CAPTURES_DIR:
    shutil.rmtree() never follows a symlink into its target, it just
    unlinks the symlink itself, so CAPTURES_DIR (read-only, shared across
    projects) is never touched. Irreversible; the frontend gates this
    behind a confirmation that requires typing the project name.
    """
    project = _project_or_404(name)
    shutil.rmtree(project)
    return {"deleted": name}


@app.delete("/projects/{name}/nights/{night}")
def delete_night(name: str, night: str):
    """Remove one staged night: its raw/nights/<night> symlinks and any
    process/nights/<night> artifacts (master flat, per-night stack
    scratch/result) — not the whole project. Frees up the "remove and
    re-stage" workflow the frontend didn't previously support at all.
    Shared master_bias/master_dark and any already-completed merged stack
    are untouched (a merged result that included this night becomes
    stale, but that's the same situation as excluding frames after a
    stack already ran — nothing here tries to detect or clean that up).
    """
    project = _project_or_404(name)
    if not night or "/" in night or night in (".", ".."):
        raise HTTPException(status_code=400, detail=f"invalid night name: {night!r}")
    raw_night = project / "raw" / "nights" / night
    if not raw_night.is_dir():
        raise HTTPException(status_code=404, detail=f"unknown night {night!r}")
    shutil.rmtree(raw_night)
    process_night = project / "process" / "nights" / night
    if process_night.is_dir():
        shutil.rmtree(process_night)
    meta = config.read_project_meta(project)
    meta.get("night_labels", {}).pop(night, None)
    config.write_project_meta(project, meta)
    return {"deleted": night}


@app.get("/projects/{name}/status")
def project_status(name: str):
    project = _project_or_404(name)
    return status.project_status(project)


@app.get("/projects/{name}/broken-links")
def check_broken_links(name: str):
    """Check every staged symlink under raw/ for a target that no longer
    exists — e.g. something outside this app moved or deleted a file in
    CAPTURES_DIR after it was staged (a real possibility once a separate
    tool manages that whole archive — see Handoff.md's file-management
    scope note). A dedicated endpoint, not folded into /status: one
    stat-like syscall per staged file means a project with hundreds of
    frames could take noticeably longer than the fast, essential status
    load the frontend calls constantly — the frontend calls this
    separately, once, asynchronously after status loads, so a slow check
    never blocks anything else from rendering.
    """
    project = _project_or_404(name)
    raw = project / "raw"
    broken = []
    checked = 0
    if raw.is_dir():
        for p in raw.rglob("*"):
            if p.is_symlink():
                checked += 1
                if not p.exists():  # exists() follows the symlink; False means the target is gone
                    broken.append(str(p.relative_to(project)))
    return {"checked": checked, "broken": broken}


@app.get("/captures/browse")
def browse_captures(path: str = ""):
    """List subdirectories under CAPTURES_DIR (read-only) so the frontend
    can offer a folder picker for /projects/{name}/stage instead of
    requiring exact paths to be typed — matches the reference Siril
    multi-night tool's "Browse..." buttons for lights/darks/flats/biases.
    """
    base = config.CAPTURES_DIR.resolve()
    target = (base / path).resolve() if path else base
    if target != base and base not in target.parents:
        raise HTTPException(status_code=400, detail="path escapes CAPTURES_DIR")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory under captures: {path!r}")
    dirs = sorted(p.name for p in target.iterdir() if p.is_dir())
    fit_names = [p.name for pat in ("*.fit", "*.fits") for p in target.glob(pat)]
    # One representative file's actual FITS header - not filename-based
    # like everything else above, and only read once per browse call
    # (see fitsinfo.py) since it needs real file I/O. Backs Stage-time
    # warnings for the wrong camera or a too-far-off capture date on
    # calibration frames, which no filename convention encodes.
    sample = fitsinfo.read_sample_fits_info(target)
    return {
        "path": path,
        "dirs": dirs,
        "fit_count": len(fit_names),
        "detected_type": frameinfo.detect_frame_type(fit_names),
        "detected_exposure_s": frameinfo.detect_exposure_seconds(fit_names),
        # Distinct filter codes found in this folder (e.g. ["H","O","S"]
        # for a mixed narrowband folder), empty for OSC/no-filter-wheel
        # data - lets the frontend offer a filter picker only when this
        # folder actually mixes more than one filter together.
        "detected_filters": frameinfo.detect_filters(fit_names),
        "sample_date_obs": sample["date_obs"],
        "sample_instrument": sample["instrument"],
    }


def _project_relative_file(project: Path, path: str) -> Path:
    """Resolve `path` as relative to `project`, rejecting anything that
    would escape it. Deliberately checks the LEXICAL path, not the
    symlink-resolved one: every raw light/flat under raw/ is itself a
    symlink pointing outside the project entirely, into CAPTURES_DIR (see
    app/staging.py) — that's by design, not a traversal attempt.
    Resolving symlinks before the containment check (an earlier version
    of the preview endpoint did this) rejected every raw frame preview
    with "path escapes project directory", since the resolved target is
    never actually under the project dir.
    """
    rel = Path(path)
    if rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(status_code=400, detail="path escapes project directory")
    candidate = project / rel
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path!r}")
    return candidate


@app.get("/projects/{name}/preview")
def project_preview(
    name: str,
    path: str,
    max_size: int = imaging.DEFAULT_MAX_SIZE,
    stretch: str = imaging.DEFAULT_STRETCH,
    debayer: bool = False,
):
    """Quick-look PNG for a FITS file inside this project (a raw light,
    during review, or a finished result.fit) — see app/imaging.py.
    `stretch` is one of "none"/"linked"/"unlinked" (only meaningfully
    different for multi-channel calibrated/stacked data). `debayer` only
    matters for a raw (single-plane) OSC sub — the frontend passes it
    based on this project's own `is_osc` setting (see /status).
    """
    project = _project_or_404(name)
    candidate = _project_relative_file(project, path)
    try:
        png_bytes = imaging.render_preview_png(candidate, max_size=max_size, stretch=stretch, debayer=debayer)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not render preview: {exc}") from exc
    return Response(content=png_bytes, media_type="image/png")


@app.get("/projects/{name}/browse")
def browse_project(name: str, path: str = ""):
    """List subdirectories and .fit/.fits files under this project's own
    directory, for the Stack section's master dark/flat override file
    pickers (see app/static/) — distinct from /captures/browse, which
    browses the read-only source captures instead. Files are returned
    with their absolute path since that's what StackLightsRequest's
    master_dark/master_flat overrides expect (see app/ssf.py).
    """
    project = _project_or_404(name)
    base = project.resolve()
    target = (base / path).resolve() if path else base
    if target != base and base not in target.parents:
        raise HTTPException(status_code=400, detail="path escapes project directory")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory in project: {path!r}")
    dirs = sorted(p.name for p in target.iterdir() if p.is_dir())
    files = sorted(
        (p.name for p in target.iterdir() if p.is_file() and p.suffix.lower() in (".fit", ".fits")),
    )
    return {
        "path": path,
        "dirs": dirs,
        "files": [{"name": name_, "abs_path": str(target / name_)} for name_ in files],
    }


@app.get("/projects/{name}/download")
def project_download(name: str, path: str):
    """Download the raw FITS file at `path` (e.g. the final result.fit)
    at full resolution — see app/static/'s Stack section.
    """
    project = _project_or_404(name)
    candidate = _project_relative_file(project, path)
    return FileResponse(candidate, media_type="application/octet-stream", filename=candidate.name)


@app.post("/projects/{name}/stage")
def stage_project(name: str, req: StageProjectRequest | None = None):
    """Symlink raw frames from CAPTURES_DIR into this project's raw/ tree,
    creating the project if it doesn't exist yet.
    """
    project = _project_path(name)
    try:
        summary = staging.stage_project(project, req or StageProjectRequest())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"project": name, "staged": summary}


@app.post("/projects/{name}/calibration-overrides")
def set_calibration_overrides(name: str, req: CalibrationOverridesRequest):
    """Set which nights use a different dark/flat master than their normal
    default (see CalibrationOverridesRequest) - the "aligning calibration
    frames to nights" panel on the frontend's Masters step. Replaces
    whatever was recorded before entirely; the frontend always sends its
    complete current picture, not an incremental change.
    """
    project = _project_or_404(name)
    meta = config.read_project_meta(project)
    meta["night_dark_overrides"] = req.night_dark_overrides
    meta["night_flat_overrides"] = req.night_flat_overrides
    config.write_project_meta(project, meta)
    return {"ok": True}


def _render_steps_text(steps: list[ssf.SirilStep]) -> str:
    """Join several independent siril-cli scripts into one dry-run preview,
    clearly marked as separate invocations — see Handoff.md gotcha #8 for
    why /masters and /stack no longer run as a single combined script.
    """
    parts = []
    for i, step in enumerate(steps):
        parts.append(f"# ==== siril-cli invocation {i + 1}/{len(steps)}: {step.label} ====\n{step.script}")
    return "\n".join(parts)


def _reject_if_job_running(name: str) -> None:
    """A second /masters/run or /stack/run against a project that already
    has one in flight (from this client, another browser tab, or a raw
    Swagger/curl call) races on the same scratch directories and can 500
    (Handoff.md's Frontend/web gotcha #4). The frontend disabling its own
    Run button only prevents that from *this* tab; this closes the gap
    server-side, for any client.
    """
    if jobs.has_running_job(name):
        raise HTTPException(status_code=409, detail=f"a job is already running for project {name!r}")


def _run_steps(steps: list[ssf.SirilStep], project: Path, name: str, kind: str) -> dict:
    """Wipe each step's fresh_dir, wire up its move (if any), and hand the
    whole list to jobs.create_multi_script_job() — one subprocess per
    step, in order (Handoff.md gotcha #8).
    """
    ssf.prepare_fresh_dirs([s.fresh_dir for s in steps if s.fresh_dir is not None])
    job_steps = [
        jobs.ScriptStep(
            script=s.script,
            workdir=s.workdir,
            label=s.label,
            on_success=(lambda move=s.move: ssf.perform_move(move)) if s.move else None,
        )
        for s in steps
    ]
    job = jobs.create_multi_script_job(job_steps, project / "logs", project=name, kind=kind)
    return {"job_id": job.id}


@app.post("/projects/{name}/masters/render", response_class=PlainTextResponse)
def render_masters(name: str, req: BuildMastersRequest):
    project = _project_or_404(name)
    try:
        steps = ssf.render_build_masters(project, req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _render_steps_text(steps)


@app.post("/projects/{name}/masters/run")
def run_masters(name: str, req: BuildMastersRequest):
    project = _project_or_404(name)
    _reject_if_job_running(name)
    try:
        steps = ssf.render_build_masters(project, req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _run_steps(steps, project, name, "masters")


@app.post("/projects/{name}/stack/render", response_class=PlainTextResponse)
def render_stack(name: str, req: StackLightsRequest):
    project = _project_or_404(name)
    try:
        steps, _nights, _selections, _output_name = ssf.render_stack_lights(project, req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _render_steps_text(steps)


@app.post("/projects/{name}/stack/run")
def run_stack(name: str, req: StackLightsRequest):
    project = _project_or_404(name)
    _reject_if_job_running(name)
    try:
        steps, nights, selections, output_name = ssf.render_stack_lights(project, req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    ssf.apply_light_selections(selections)
    # Recorded before the job actually runs (its output filename is fixed
    # once rendered, and /status only ever reports a result as present if
    # the file exists on disk anyway - a failed run just leaves a stale,
    # harmless filename here until the next successful one overwrites it).
    meta = config.read_project_meta(project)
    if len(nights) > 1:
        meta["merged_result_filename"] = f"{output_name}.fit"
    else:
        meta.setdefault("night_result_filenames", {})[nights[0]["key"]] = f"{output_name}.fit"
    config.write_project_meta(project, meta)
    return _run_steps(steps, project, name, "stack")


@app.post("/projects/{name}/lights/analyze/render")
def render_analyze(name: str, req: AnalyzeLightsRequest):
    """Dry run: resolve `nights`/`exclude_frames` and report which files
    would be analyzed, without actually running anything. No Siril, no
    .ssf script involved anymore — see AnalyzeLightsRequest's docstring
    for why this no longer shells out to Siril at all.
    """
    project = _project_or_404(name)
    try:
        targets = framestats.resolve_analyze_targets(project, req.nights, req.exclude_frames)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "nights": {
            t.key: {"lights_dir": str(t.lights_dir), "file_count": len(t.files), "files": [f.name for f in t.files]}
            for t in targets
        }
    }


@app.post("/projects/{name}/lights/analyze/run")
def run_analyze(name: str, req: AnalyzeLightsRequest):
    """Compute per-frame quality-review stats directly from raw light
    frames via astropy+photutils (app/framestats.py) — no Siril, no
    masters needed. Nothing is excluded here; this is the
    recommend-don't-auto-filter review step. See AnalyzeLightsRequest's
    and app/framestats.py's docstrings, and Handoff.md, for why this
    stopped shelling out to Siril.
    """
    project = _project_or_404(name)
    try:
        targets = framestats.resolve_analyze_targets(project, req.nights, req.exclude_frames)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    total_files = sum(len(t.files) for t in targets)

    def work(progress) -> dict:
        result: dict = {"nights": {}}
        done = 0
        for target in targets:
            night_stats = []
            for f in target.files:
                progress(
                    (done / total_files * 100.0) if total_files else 100.0,
                    f"analyzing {target.key}: {f.name} ({done + 1}/{total_files})",
                )
                stats = framestats.analyze_frame(f, bin_factor=req.bin_factor, threshold_sigma=req.threshold_sigma)
                night_stats.append(stats)
                done += 1
            # Anomaly flagging compares each frame against the rest of
            # THIS night only (see flag_anomalies' docstring) — done after
            # the whole night's stats are in, not per-frame.
            framestats.flag_anomalies(night_stats, z_threshold=req.anomaly_sigma)
            # Chronological, not filename, order: failed frames tend to
            # come in clumps (clouds rolling through, dusk/dawn), which
            # only reads clearly if the sequence is in actual capture
            # order. Frames without a DATE-OBS (shouldn't happen for real
            # captures) sort last rather than crashing the comparison.
            night_stats.sort(key=lambda s: s.captured_at or "9999")
            result["nights"][target.key] = [s.__dict__ for s in night_stats]
        return result

    job = jobs.create_python_job(work, project / "logs", workdir=project, project=name, kind="analyze")
    return {"job_id": job.id}


@app.get("/projects/{name}/jobs")
def list_project_jobs(name: str):
    """All jobs run for this project since the server last started
    (in-memory only, see app/jobs.py), newest first — backs the frontend's
    job history panel and its cross-tab "is anything running right now"
    polling.
    """
    _project_or_404(name)
    return {"jobs": [j.snapshot() for j in jobs.list_jobs(name)]}


@app.get("/jobs")
def list_all_jobs_route():
    """Every job across every project, newest first — backs the
    frontend's global "active jobs" panel, so a stack running in one
    project stays visible while looking at a completely different one.
    """
    return {"jobs": [j.snapshot() for j in jobs.list_all_jobs()]}


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job")
    return job.snapshot()


@app.get("/jobs/{job_id}/log", response_class=PlainTextResponse)
def job_log(job_id: str):
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job")
    if not job.log_path.exists():
        return ""
    return job.log_path.read_text()


# Mounted last, deliberately: Starlette matches routes in registration
# order, so every API route above still wins over this catch-all. Only
# unmatched paths (/, /app.js, /styles.css, ...) fall through to here.
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
