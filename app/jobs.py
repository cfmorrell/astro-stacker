"""Minimal in-memory background job manager.

Stacking runs can take an hour+ (see Handoff.md), so /masters/run and
/stack/run can't block the request thread. This runs siril-cli in a
background thread and exposes status + a rolling "current_line" plus the
full log file for polling from the UI. It's intentionally simple (no
persistence, no multi-worker coordination) — good enough for a single-user,
single-process FastAPI app on one NAS box. If this ever needs to survive a
server restart or run across multiple workers, swap this for a real queue
(e.g. a SQLite-backed job table) rather than growing this module in place.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

from . import siril_runner


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
                "current_line": self.current_line,
                "error": self.error,
            }


_jobs: Dict[str, Job] = {}
_registry_lock = threading.Lock()


def create_job(script_text: str, workdir: Path, log_dir: Path) -> Job:
    job_id = uuid.uuid4().hex[:12]
    log_path = log_dir / f"{job_id}.log"
    job = Job(id=job_id, workdir=workdir, log_path=log_path)
    with _registry_lock:
        _jobs[job_id] = job

    def on_line(line: str) -> None:
        with job._lock:
            job.current_line = line

    def _run() -> None:
        with job._lock:
            job.status = "running"
            job.started_at = time.time()
        try:
            rc = siril_runner.run_script(script_text, workdir, log_path, on_line=on_line)
            with job._lock:
                job.return_code = rc
                job.status = "succeeded" if rc == 0 else "failed"
        except Exception as exc:  # defensive: e.g. siril binary missing
            with job._lock:
                job.status = "failed"
                job.error = str(exc)
        finally:
            with job._lock:
                job.ended_at = time.time()

    threading.Thread(target=_run, daemon=True, name=f"job-{job_id}").start()
    return job


def get_job(job_id: str) -> Optional[Job]:
    with _registry_lock:
        return _jobs.get(job_id)
