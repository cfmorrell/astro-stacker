"""Shells out to siril-cli and streams its output.

Per Handoff.md gotcha #1: SIRIL_BIN alone launches the GUI and fails
headless ("cannot open display"). The AppImage's AppRun dispatches on its
*first positional argument* — "siril-cli" selects headless mode. That
argument must stay a separate element of the subprocess argv list; folding
it into the SIRIL_BIN string and relying on shell word-splitting doesn't
work here since we never invoke via a shell.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable, Optional

from . import config


def run_script(
    script_text: str,
    workdir: Path,
    log_path: Path,
    on_line: Optional[Callable[[str], None]] = None,
) -> int:
    """Write script_text to a scratch .ssf file under workdir and run it via
    siril-cli, streaming combined stdout/stderr line-by-line to log_path and
    to on_line() as it arrives. Returns the process's exit code (does not
    raise on a non-zero exit — that's the caller's job).
    """
    workdir.mkdir(parents=True, exist_ok=True)
    script_path = workdir / ".job.ssf"
    script_path.write_text(script_text)

    # -d sets Siril's working directory for the whole session (gotcha #3);
    # every relative path in the rendered script resolves against it. We
    # render absolute paths throughout ssf.py, so this mostly just matters
    # as Siril's initial cwd.
    cmd = [config.SIRIL_BIN, "siril-cli", "-s", str(script_path), "-d", str(workdir)]

    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w") as log_file:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            log_file.write(line)
            log_file.flush()
            if on_line:
                on_line(line.rstrip("\n"))
        return proc.wait()
