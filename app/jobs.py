"""Minimal in-memory background job manager.

Stacking runs can take an hour+ (see Handoff.md), so /masters/run and
/stack/run can't block the request thread. Two ways to run one:
- `create_multi_script_job()` — one or more independent siril-cli
  invocations, run one after another as SEPARATE subprocesses within one
  job. This exists specifically for gotcha #8: running multiple
  sequences' calibrate+register in *one* Siril session causes a severe,
  confirmed performance cliff (identical work: 10s alone vs 90s as the
  2nd sequence in one process). Giving each night (or each master type)
  its own fresh siril-cli process sidesteps that entirely — see
  app/ssf.py's render_stack_lights()/render_build_masters(), which build
  the step list.
- `create_python_job()` — an arbitrary Python callable, no Siril at all;
  used by /lights/analyze (app/framestats.py).

Both share the same Job/snapshot shape so /jobs/{id} doesn't need to know
which kind it's looking at.

Intentionally simple (no persistence, no multi-worker coordination) — good
enough for a single-user, single-process FastAPI app on one NAS box. If
this ever needs to survive a server restart or run across multiple
workers, swap this for a real queue (e.g. a SQLite-backed job table)
rather than growing this module in place.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Optional

from . import siril_runner

# siril-cli prints lines like:
#   progress: 96.89%
#   progress: Finalizing stacking..., 99.95%
#   progress: Script execution failed., 100.00%
# and, for every command it executes:
#   log: Running command: stack
_PROGRESS_RE = re.compile(r"progress:.*?(\d+(?:\.\d+)?)\s*%\s*$")
_COMMAND_RE = re.compile(r"log: Running command: (\S+)")


@dataclass
class Job:
    id: str
    workdir: Path
    log_path: Path
    status: str = "pending"  # pending -> running -> succeeded | failed
    return_code: Optional[int] = None
    started_at: Optional[float] = None
    ended_at: Optional[float] = None
    current_line: str = ""
    current_command: Optional[str] = None  # last siril command started (e.g. "convert", "register", "stack")
    percent_complete: Optional[float] = None
    result: Optional[dict] = None  # set by on_success(), e.g. parsed frame-quality stats
    error: Optional[str] = None
    # Full ordered pipeline for a create_multi_script_job() run (e.g.
    # ["night1 calibrate", "night2 calibrate", "merge+register+stack"]) —
    # known upfront, unlike current_command, so a frontend can draw the
    # whole pipeline and highlight where the job currently is. Empty for
    # single-script jobs (create_job()/create_python_job()).
    steps: list = field(default_factory=list)
    current_step_index: Optional[int] = None
    # Which project this job belongs to and what kind of run it is
    # ("masters"/"stack"/"analyze") - added for job history and cross-tab
    # awareness (see has_running_job()/list_jobs() below). Not used by
    # anything that predates that (this dataclass field has a default so
    # existing call sites that don't pass it keep working).
    project: str = ""
    kind: str = ""
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "project": self.project,
                "kind": self.kind,
                "status": self.status,
                "return_code": self.return_code,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
                "current_command": self.current_command,
                "percent_complete": self.percent_complete,
                "current_line": self.current_line,
                "steps": self.steps,
                "current_step_index": self.current_step_index,
                "result": self.result,
                "error": self.error,
            }


_jobs: Dict[str, Job] = {}
_registry_lock = threading.Lock()


def has_running_job(project: str) -> bool:
    """True if some job for this project (started from any client - this
    tab, another tab, or a raw API call) is currently running. Used to
    reject a second /masters/run or /stack/run against the same project
    before it can race with the first on shared scratch directories (see
    Handoff.md's Frontend/web gotcha #4) — a server-side close of that
    gap, not just the frontend's own same-tab button-disabling.
    """
    with _registry_lock:
        return any(j.project == project and j.status == "running" for j in _jobs.values())


def list_jobs(project: str) -> list[Job]:
    """All known jobs for a project, newest-started first. Only reflects
    jobs this server process has run since it last started (in-memory,
    not persisted) - a restart clears history same as it already clears
    everything else in _jobs.
    """
    with _registry_lock:
        jobs = [j for j in _jobs.values() if j.project == project]
    return sorted(jobs, key=lambda j: j.started_at or 0, reverse=True)


def list_all_jobs() -> list[Job]:
    """Every known job across every project, newest-started first - backs
    the frontend's global "active jobs" panel so running a stack in one
    project is visible while looking at a completely different one,
    instead of only ever seeing what's running for whichever project
    happens to be open right now.
    """
    with _registry_lock:
        jobs = list(_jobs.values())
    return sorted(jobs, key=lambda j: j.started_at or 0, reverse=True)


@dataclass
class ScriptStep:
    """One independent siril-cli invocation within a create_multi_script_job()
    run. `on_success`, if given, runs immediately after this step's exit
    code is 0 and *before* the next step starts — e.g. moving a just-built
    master_bias.fit to its stable location so the next step (a flat build)
    can reference it there. A step's own failure stops the whole job;
    later steps never run.
    """

    script: str
    workdir: Path
    label: str  # shown in progress messages, e.g. "night1 calibrate", "master_bias"
    on_success: Optional[Callable[[], None]] = None


def create_multi_script_job(
    steps: list[ScriptStep],
    log_dir: Path,
    on_all_success: Optional[Callable[[], dict]] = None,
    project: str = "",
    kind: str = "",
) -> Job:
    """Run several independent siril-cli invocations in order, each its own
    subprocess (see module docstring — this is the gotcha #8 fix). All
    steps' output appends to one shared log file. Stops at the first
    failing step; `on_all_success()`, if given, runs once every step has
    succeeded, and its return value is stored as job.result.
    """
    job_id = uuid.uuid4().hex[:12]
    log_path = log_dir / f"{job_id}.log"
    job = Job(
        id=job_id,
        workdir=steps[0].workdir if steps else log_dir,
        log_path=log_path,
        steps=[s.label for s in steps],
        project=project,
        kind=kind,
    )
    with _registry_lock:
        _jobs[job_id] = job

    total = len(steps)

    def _run() -> None:
        with job._lock:
            job.status = "running"
            job.started_at = time.time()
        try:
            for i, step in enumerate(steps):
                base = i / total * 100.0 if total else 0.0
                span = 100.0 / total if total else 100.0
                with job._lock:
                    job.current_step_index = i

                def on_line(line: str, base=base, span=span, label=step.label) -> None:
                    with job._lock:
                        job.current_line = f"[{label}] {line}"
                        m = _COMMAND_RE.search(line)
                        if m:
                            job.current_command = m.group(1)
                        m = _PROGRESS_RE.search(line)
                        if m:
                            job.percent_complete = base + float(m.group(1)) / 100.0 * span

                rc = siril_runner.run_script(
                    step.script, step.workdir, log_path, on_line=on_line, append_log=(i > 0)
                )
                if rc != 0:
                    with job._lock:
                        job.return_code = rc
                        job.status = "failed"
                        job.error = f"step {i + 1}/{total} ({step.label}) failed"
                    return
                if step.on_success is not None:
                    step.on_success()

            with job._lock:
                job.return_code = 0
                job.status = "succeeded"
            if on_all_success is not None:
                try:
                    result = on_all_success()
                    with job._lock:
                        job.result = result
                except Exception as exc:  # defensive
                    with job._lock:
                        job.error = f"post-processing failed: {exc}"
        except Exception as exc:  # defensive: e.g. siril binary missing
            with job._lock:
                job.status = "failed"
                job.error = str(exc)
        finally:
            with job._lock:
                job.ended_at = time.time()
                if job.status == "succeeded":
                    job.percent_complete = 100.0

    threading.Thread(target=_run, daemon=True, name=f"job-{job_id}").start()
    return job


def create_python_job(
    work: Callable[[Callable[[float, str], None]], dict],
    log_dir: Path,
    workdir: Optional[Path] = None,
    project: str = "",
    kind: str = "",
) -> Job:
    """Run an arbitrary Python callable in a background thread instead of
    siril-cli. `work(progress)` does the actual computation, calling
    `progress(percent, message)` as it goes, and returns a dict stored as
    job.result on success. No subprocess, no return code (always 0 on
    success) — see app/framestats.py, which uses this for /lights/analyze
    (stateless numpy/astropy work per frame; no Siril session to degrade).
    """
    job_id = uuid.uuid4().hex[:12]
    log_path = log_dir / f"{job_id}.log"
    # siril_runner.run_script() does this itself for the Siril-based job
    # types (create_job/create_multi_script_job) - this path has no
    # subprocess to do it for us, so a project that goes straight from
    # Stage to Review without ever building masters first (logs/ only
    # ever gets created as a side effect of a Siril run) crashed here
    # with a bare "No such file or directory" the first time /lights/
    # analyze/run tried to open its log file.
    log_path.parent.mkdir(parents=True, exist_ok=True)
    job = Job(id=job_id, workdir=workdir or log_dir, log_path=log_path, project=project, kind=kind)
    with _registry_lock:
        _jobs[job_id] = job

    def progress(percent: float, message: str) -> None:
        with job._lock:
            job.percent_complete = percent
            job.current_line = message
        with log_path.open("a") as f:
            f.write(f"{message}\n")

    def _run() -> None:
        with job._lock:
            job.status = "running"
            job.started_at = time.time()
        try:
            result = work(progress)
            with job._lock:
                job.result = result
                job.status = "succeeded"
                job.return_code = 0
        except Exception as exc:
            with job._lock:
                job.status = "failed"
                job.error = str(exc)
        finally:
            with job._lock:
                job.ended_at = time.time()
                if job.status == "succeeded":
                    job.percent_complete = 100.0

    threading.Thread(target=_run, daemon=True, name=f"job-{job_id}").start()
    return job


def get_job(job_id: str) -> Optional[Job]:
    with _registry_lock:
        return _jobs.get(job_id)
