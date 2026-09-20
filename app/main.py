"""FastAPI app: render .ssf scripts (dry-run) or run them as background jobs.

No file-browser UI yet beyond /projects/{name}/stage — everything else
still takes typed directory/project names, matching the on-disk layout
(raw/, process/) documented in app/ssf.py's module docstring.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse

from . import config, framestats, jobs, ssf, staging
from .models import (
    AnalyzeLightsRequest,
    BuildMastersRequest,
    StackLightsRequest,
    StageProjectRequest,
)

app = FastAPI(title="astro-stacker")


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


@app.post("/projects/{name}/stage")
def stage_project(name: str, req: StageProjectRequest | None = None):
    """Symlink raw frames from CAPTURES_DIR into this project's raw/ tree,
    creating the project if it doesn't exist yet. Replaces manual `mkdir` +
    scripts/stage_captures.sh.
    """
    project = _project_path(name)
    try:
        summary = staging.stage_project(project, req or StageProjectRequest())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"project": name, "staged": summary}


@app.post("/projects/{name}/masters/render", response_class=PlainTextResponse)
def render_masters(name: str, req: BuildMastersRequest):
    project = _project_or_404(name)
    try:
        return ssf.render_build_masters(project, req).text
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/projects/{name}/masters/run")
def run_masters(name: str, req: BuildMastersRequest):
    project = _project_or_404(name)
    try:
        rendered = ssf.render_build_masters(project, req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    for d in rendered.ensure_dirs:
        d.mkdir(parents=True, exist_ok=True)
    job = jobs.create_job(rendered.text, project, project / "logs")
    return {"job_id": job.id}


@app.post("/projects/{name}/stack/render", response_class=PlainTextResponse)
def render_stack(name: str, req: StackLightsRequest):
    project = _project_or_404(name)
    try:
        return ssf.render_stack_lights(project, req).text
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/projects/{name}/stack/run")
def run_stack(name: str, req: StackLightsRequest):
    project = _project_or_404(name)
    try:
        rendered = ssf.render_stack_lights(project, req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    ssf.prepare_fresh_dirs(rendered.fresh_dirs)
    ssf.apply_light_selections(rendered.light_selections)
    job = jobs.create_job(rendered.text, project, project / "logs")
    return {"job_id": job.id}


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
                night_stats.append(stats.__dict__)
                done += 1
            result["nights"][target.key] = night_stats
        return result

    job = jobs.create_python_job(work, project / "logs", workdir=project)
    return {"job_id": job.id}


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
