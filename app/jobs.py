"""Minimal in-memory background job manager.

Stacking runs can take an hour+ (see Handoff.md), so /masters/run and
/stack/run can't block the request thread. `create_job()` runs siril-cli
in a background thread and exposes status, parsed progress, and a rolling
"current_line" plus the full log file for polling from the UI.
`create_python_job()` runs an arbitrary Python callable the same way
instead — used by /lights/analyze (app/framestats.py), which doesn't
invoke Siril at all. Both share the same Job/snapshot shape so /jobs/{id}
doesn't need to know which kind it's looking at.

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
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "status": self.status,
                "return_code": self.return_code,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
                "current_command": self.current_command,
                "percent_complete": self.percent_complete,
                "current_line": self.current_line,
                "result": self.result,
                "error": self.error,
            }


_jobs: Dict[str, Job] = {}
_registry_lock = threading.Lock()


def create_job(
    script_text: str,
    workdir: Path,
    log_dir: Path,
    on_success: Optional[Callable[[], dict]] = None,
) -> Job:
    """Run script_text via siril-cli in a background thread.

    If given, on_success() is called after a zero exit code, and its
    return value is stored on job.result — e.g. parsing per-frame quality
    stats out of a .seq file for /lights/analyze. A failure in on_success
    itself doesn't flip a successful siril run to "failed"; it's recorded
    in job.error instead, since siril-cli did succeed.
    """
    job_id = uuid.uuid4().hex[:12]
    log_path = log_dir / f"{job_id}.log"
    job = Job(id=job_id, workdir=workdir, log_path=log_path)
    with _registry_lock:
        _jobs[job_id] = job

    def on_line(line: str) -> None:
        with job._lock:
            job.current_line = line
            m = _COMMAND_RE.search(line)
            if m:
                job.current_command = m.group(1)
                # A new command starting resets the previous command's
                # progress rather than leaving e.g. "100.00%" from
                # `convert` displayed while `register` is just beginning.
                job.percent_complete = 0.0
            m = _PROGRESS_RE.search(line)
            if m:
                job.percent_complete = float(m.group(1))

    def _run() -> None:
        with job._lock:
            job.status = "running"
            job.started_at = time.time()
        try:
            rc = siril_runner.run_script(script_text, workdir, log_path, on_line=on_line)
            with job._lock:
                job.return_code = rc
                job.status = "succeeded" if rc == 0 else "failed"
            if rc == 0 and on_success is not None:
                try:
                    result = on_success()
                    with job._lock:
                        job.result = result
                except Exception as exc:  # defensive: e.g. .seq parsing hiccup
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
    job = Job(id=job_id, workdir=workdir or log_dir, log_path=log_path)
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
