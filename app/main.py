"""FastAPI app: render .ssf scripts (dry-run) or run them as background jobs.

No file-browser UI yet beyond /projects/{name}/stage — everything else
still takes typed directory/project names, matching the on-disk layout
(raw/, process/) documented in app/ssf.py's module docstring.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse

from . import config, jobs, seqstats, ssf, staging
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
def render_masters(name: str, req: BuildMastersRequest | None = None):
    project = _project_or_404(name)
    try:
        return ssf.render_build_masters(project, req or BuildMastersRequest()).text
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/projects/{name}/masters/run")
def run_masters(name: str, req: BuildMastersRequest | None = None):
    project = _project_or_404(name)
    try:
        rendered = ssf.render_build_masters(project, req or BuildMastersRequest())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    for d in rendered.ensure_dirs:
        d.mkdir(parents=True, exist_ok=True)
    job = jobs.create_job(rendered.text, project, project / "logs")
    return {"job_id": job.id}


@app.post("/projects/{name}/stack/render", response_class=PlainTextResponse)
def render_stack(name: str, req: StackLightsRequest | None = None):
    project = _project_or_404(name)
    try:
        return ssf.render_stack_lights(project, req or StackLightsRequest()).text
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/projects/{name}/stack/run")
def run_stack(name: str, req: StackLightsRequest | None = None):
    project = _project_or_404(name)
    try:
        rendered = ssf.render_stack_lights(project, req or StackLightsRequest())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    ssf.prepare_fresh_dirs(rendered.fresh_dirs)
    ssf.apply_light_selections(rendered.light_selections)
    job = jobs.create_job(rendered.text, project, project / "logs")
    return {"job_id": job.id}


@app.post("/projects/{name}/lights/analyze/render", response_class=PlainTextResponse)
def render_analyze(name: str, req: AnalyzeLightsRequest | None = None):
    project = _project_or_404(name)
    try:
        return ssf.render_analyze_lights(project, req or AnalyzeLightsRequest()).text
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/projects/{name}/lights/analyze/run")
def run_analyze(name: str, req: AnalyzeLightsRequest | None = None):
    """Calibrate+register lights only (no stacking) and, once that
    succeeds, parse each night's per-frame FWHM/roundness/background/star-
    count out of Siril's own registration data. Nothing is excluded here —
    this is the recommend-don't-auto-filter review step; see
    AnalyzeLightsRequest's docstring and Handoff.md.
    """
    project = _project_or_404(name)
    try:
        rendered = ssf.render_analyze_lights(project, req or AnalyzeLightsRequest())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    ssf.prepare_fresh_dirs(rendered.fresh_dirs)
    ssf.apply_light_selections(rendered.light_selections)

    def on_success() -> dict:
        result: dict = {"nights": {}}
        for night in rendered.nights:
            process_dir: Path = night["process_dir"]
            seq_path = process_dir / "r_pp_light_.seq"
            frames = seqstats.parse_registration_stats(seq_path, source_dir=night["raw_lights"])
            result["nights"][night["key"]] = seqstats.stats_to_dicts(frames)
        return result

    job = jobs.create_job(rendered.text, project, project / "logs", on_success=on_success)
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
