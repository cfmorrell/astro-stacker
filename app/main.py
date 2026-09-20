"""FastAPI skeleton: render .ssf scripts (dry-run) or run them as background jobs.

Per Handoff.md's immediate next steps: "/build (render .ssf, don't run) and
/run (execute + stream log), background job execution for long stacks."
No file-browser UI yet — projects are typed directory names under DATA_DIR
/projects, matching the existing on-disk layout (raw/, process/).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse

from . import config, jobs, ssf
from .models import BuildMastersRequest, StackLightsRequest

app = FastAPI(title="astro-stacker")


def _project_or_404(name: str) -> Path:
    try:
        project = config.project_dir(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not project.is_dir():
        raise HTTPException(status_code=404, detail=f"unknown project {name!r}")
    return project


@app.get("/health")
def health():
    return {"status": "ok", "siril_bin": config.SIRIL_BIN, "projects_dir": str(config.PROJECTS_DIR)}


@app.post("/projects/{name}/masters/render", response_class=PlainTextResponse)
def render_masters(name: str, req: BuildMastersRequest | None = None):
    project = _project_or_404(name)
    return ssf.render_build_masters(project, req or BuildMastersRequest()).text


@app.post("/projects/{name}/masters/run")
def run_masters(name: str, req: BuildMastersRequest | None = None):
    project = _project_or_404(name)
    rendered = ssf.render_build_masters(project, req or BuildMastersRequest())
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
    for d in rendered.ensure_dirs:
        d.mkdir(parents=True, exist_ok=True)
    job = jobs.create_job(rendered.text, project, project / "logs")
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
