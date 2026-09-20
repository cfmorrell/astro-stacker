# astro-stacker — Project Context

## What this is
A minimal, self-hosted Docker container on Chris's UnRAID NAS that wraps Siril
for astrophotography calibration/registration/stacking. Point it at a lights
folder and calibration frames, pick a stacking algorithm, get back one
stacked `.fit`. All further processing (stretching, star removal, color
work) happens in other software, outside this tool. Deliberately **not**
trying to be a full workbench.

## Endstate
A docker contained self hosted web app where I can complete the following:
- Pull together lights/flats/darks/biases for processing and eventual archival
- Review, rate, and with human in the loop filter light frames by FWHM, Star Count, Eccentricity, and/or SNR
- Build the siril script to conduct multi-night image calibration and stacking
- Execute said script with the result of a single stacked .fit file that can then be postprocessed in other software. The user should be aware of the steps of the process and have approximate percentages/time until completion/etc. available.
- Once images have been appropriately archived, the working directory should be cleaned up to avoid data bloat.

## Why this exists (brief history)
Started by evaluating `bscholer/astrolab` for UnRAID. Diagnosed a real,
confirmed-in-source gap: astrolab's calibration matcher only ever reads a
`masters` table, and the only code path that populates it is Dwarf 3's
on-device factory master ingestion (`dwarf3_adapter.walk_factory_masters()`
in `scanner.py`). There is no code anywhere in astrolab that stacks raw
darks/flats/biases from real capture hardware (ASIAIR, NINA, etc.) into a
master. That's a real hole, not a config mistake.

Pivoted to building a purpose-built tool instead of patching astrolab,
because astrolab (and AstroMate before it) are architected around
smart-telescope / iterative-workbench use cases Chris doesn't have. He runs
a CEM60/AM5 with a dedicated cooled camera, already knows Siril, and does
post-processing elsewhere.

## Architecture decisions (settled, don't relitigate)
- **Option A**, not B: the tool builds masters from raw calibration subs
  itself, rather than only consuming pre-built masters. Chris explicitly
  chose this.
- Backend: FastAPI, templates `.ssf` scripts, shells out to `siril-cli`.
  No sirilpy live-session integration — headless CLI only.
- No file-browser UI for v1 — typed directory paths.  Will eventually want to add some file management (pull lights/flats from telescope controller, darks/biases from server, copy remote/link local files into working directory for processing). Once complete, archive files as directed.
- Long-running jobs (stacking can take an hour+) need background
  execution + log streaming, not a blocking HTTP request. Built as a
  minimal in-thread job manager (`app/jobs.py`) — good enough for a
  single-user, single-process app; swap for a real queue only if that
  stops being true.
- GPU: CPU-only (`:cpu`, no NVIDIA Container Toolkit on this box).
- Single repo, not split into "app" + "container" repos — one maintainer,
  one deployable, no independent lifecycle for the Dockerfile.

## Reference material already pulled (don't re-derive from scratch)
- `bscholer/astrolab`'s `templates/calibrate_register_stack.yaml` — the
  actual production Siril command sequence (convert → calibrate → resample
  → offset → bg_extract → register → stack → crop). Strip everything after
  `stack`/`crop` (GraXpert, StarNet, stretch) — Chris does that elsewhere.
- `github.com/rolandet/siril-scripts` — **read v1.2, not the current v3.0**.
  v1.2 is plain OSC multi-night stacking, matching this project's scope.
  v2.0+ added mosaic panels and narrowband extraction — out of scope, don't
  port that complexity in.
- Same repo: `make_master_darks_auto.py` / `make_master_biases_auto.py` —
  standalone scripts that already solve "stack raw calibration subs into a
  master." Read before writing this logic from scratch.
- `free-astro/siril-scripts` (official Siril team repo, GitLab) — canonical
  `.ssf` scripts (`OSC_Preprocessing*.ssf`, etc.) for reference syntax.
- **Licensing:** rolandet's and free-astro's scripts are GPLv3. If this
  repo goes public and substantially reuses their logic, it inherits that
  obligation. Currently private on GitHub for this reason.  Assume eventual GPLv3.

## Environment / paths (confirmed, don't ask again)
- NAS: UnRAID, host `FractalR5Tower`, SSH alias `unraid`.
- Repo: `git@github.com:cfmorrell/astro-stacker.git`, private.
- SSH key for git: `/mnt/user/docker_appdata/astro-stacker/.ssh/id_ed25519`
  (repo-local `core.sshCommand`, not global — bare UnRAID host doesn't
  persist `/root` across reboots, so nothing global-config lives there).
- `src/` = git repo = bind-mounted into the dev container at `/app`.
- `data/` = NOT in git = bind-mounted at `/data`. Runtime cache, staged
  captures, project output.
- Captures test data: `/mnt/user/Astronomy/013-Astro-Stacker-Processing`
  (separate from astrolab's own capture folder, deliberately, so the two
  projects don't collide) — mounted `:ro` at `/captures`.
- Dev container: `astro-stacker-dev`, long-lived (`docker run -d ... tail -f
  /dev/null`), not `--rm`. SSH alias `astro-stacker` drops straight into a
  shell in it (`RemoteCommand docker exec -it astro-stacker-dev bash`).
- Dockerfile changes need `docker build` + `stop`/`rm`/`run` to take effect.
  Changes under `src/` (bind-mounted) are live immediately, no rebuild.

## Siril gotchas discovered the hard way (do not rediscover these)
1. **`$SIRIL_BIN` alone launches the GUI, not the CLI**, and fails
   headless with "cannot open display." The AppImage's `AppRun` dispatches
   on its *first positional argument*: `siril-cli` for headless mode. Always
   invoke as `$SIRIL_BIN siril-cli -s script.ssf -d workdir` — as a
   separate list element if building the subprocess call in Python, never
   concatenated into the `SIRIL_BIN` string itself (breaks under
   `subprocess.run([...])`, which doesn't shell-word-split).
2. **Siril's `cd` command requires its target to be *writable*, not just
   readable/executable.** If it isn't, Siril doesn't report a permission
   error — it reports "directory not found," even though the directory
   demonstrably exists. Confirmed as a known upstream behavior (Siril
   GitLab issue #1262, same symptom, different user, same root cause).
   **Consequence: Siril can never `cd` directly into the read-only
   `/captures` mount.** Fix in place: `scripts/stage_captures.sh`
   symlinks raw frames from `/captures/{lights,darks,flats,biases}` into
   a writable `data/projects/<name>/raw/{...}` tree before Siril runs.
   `/captures` stays `:ro` always; Siril never touches it directly, even
   for reads.
3. `-d` sets Siril's working directory for the *session*, not per-command.
   Relative paths in a script resolve against whatever `-d` pointed at.
4. **`cd "path"` strips quotes correctly; `-key="path"` style options do
   NOT.** `cd "/data/projects/x"` works fine, but `convert bias
   -out="/data/projects/x/process"` creates a directory literally named
   `"/data/projects/x/process"` (quote characters included) inside the
   *source* dir instead — the quotes become part of the value, and since
   that path doesn't exist, the write silently lands somewhere unintended.
   Confirmed empirically (2026-09-20, `app/ssf.py` testing). Same applies
   to `-dark=`/`-flat=`/etc. **Consequence:** in templates, keep `cd`
   targets quoted but leave `-key=value` path arguments unquoted (fine for
   this project since paths never contain spaces — sanitized project/night
   names, no spaces in the NAS mount tree).
5. **`convert ... -out=<dir>` does not create `<dir>` itself** — it must
   already exist, or the command silently fails to write there (compounds
   with gotcha #4: it *looks* like it succeeded because Siril's log still
   says "N file(s) created," just not where you expect). `app/ssf.py`'s
   `RenderedScript.ensure_dirs` list exists for exactly this: callers
   `mkdir -p` every directory a script will `cd`/write into *before*
   invoking siril-cli, rather than relying on Siril to create anything.

## Current validated status
- ✅ Docker build/run/exec loop works on the NAS.
- ✅ git push works with the repo-local SSH key.
- ✅ `siril-cli` invocation confirmed correct (gotcha #1 above).
- ✅ Read-only/writable-cd conflict diagnosed and solved (gotcha #2, #3).
- ✅ `convert` step tested successfully against real light frames (96/96
  converted) using the staged/symlinked working directory.
- ✅ **Full pipeline tested end-to-end and confirmed working**: master
  bias → master dark → master flat (bias-calibrated) → light calibration
  (dark + flat, cosmetic correction, CFA equalization, debayer) →
  registration → rejection-stacked, normalized result. Produced a real,
  correctly-sized `result.fit` from actual capture data (ASI2600MC Duo,
  OSC). This is the reference implementation — port its logic into Python,
  don't re-derive the Siril command sequence from scratch.
- ✅ **Python/FastAPI layer built and tested end-to-end against real
  capture data (2026-09-20)**: `app/` now has `config.py`, `models.py`
  (Pydantic request models — `StackMethod`/`StackOptions` is the "few
  different stacking algorithms" knob), `ssf.py` (Jinja2 rendering from
  `templates/*.ssf.j2`), `siril_runner.py` (subprocess invocation +
  streaming), `jobs.py` (in-memory background job manager), and
  `main.py` (FastAPI app). Master-building and calibrate/register/stack
  are split into two independent phases as planned, each with its own
  `/render` (dry-run, no side effects) and `/run` (background job)
  endpoint. Verified by standing up uvicorn in the dev container and
  hitting it with real HTTP requests against a freshly-staged project
  (`test2`, since-deleted test scaffolding — `test1` and its validated
  `result.fit` were never touched): masters build succeeded
  (`master_bias.fit`/`master_dark.fit`/`master_flat.fit` all produced),
  then a full stack run against 10 real Heart Nebula lights succeeded in
  ~18s end-to-end through the API (job manager, log streaming, and all),
  producing a correctly-sized `result.fit` (6248x4176, 3-layer, 32-bit —
  same dimensions as `test1`'s). Found and fixed two new Siril gotchas in
  the process (#4 and #5 above) that the original manual walkthrough
  didn't hit because it never varied the working directory structure.
- ✅ Multi-night stacking implemented in `ssf.py`/`calibrate_stack.ssf.j2`
  (per-night `pp_light` sequences merged via Siril's `merge`, following
  the pattern in rolandet's v1.2/v3.0 scripts) but **not yet validated
  against real multi-night data** — only render-tested (syntax checked,
  never actually run through siril-cli). Single-night path is the
  well-trodden one; treat multi-night as unverified until run for real.
- ❌ No `crop` step yet (trims the ragged registration border) — still
  deliberately deferred. Punted again because Siril's actual crop syntax
  (region-based `crop x y width height`, not a margin-trim) needs to be
  verified against a real registered frame's dimensions before wiring it
  in; guessing at the arguments for a destructive image op isn't worth
  the risk of silently producing wrong output.
- ❌ No project-creation/staging endpoint — `mkdir` + `stage_captures.sh`
  still have to be run by hand before `/masters/run`. Fine for now (no
  file-browser UI is a stated v1 non-goal), but worth wrapping once a
  real UI shows up.
- ❌ No log-based progress/ETA parsing — `/jobs/{id}` exposes the raw
  current log line (siril-cli does print `progress: N%` lines) but
  nothing turns that into the "aware of steps/percentages/time" UX the
  Endstate asks for. The raw signal is there; nobody's parsed it yet.

## Validated `.ssf` script (known-good reference — don't rederive)
Tested against staged raw frames at `data/projects/test1/raw/{lights,darks,flats,biases}`
(symlinks into `/captures`, built by `scripts/stage_captures.sh`), run as:
`$SIRIL_BIN siril-cli -s script.ssf -d /data/projects/test1`

```
requires 1.4.0

# ---- Master bias ----
cd raw/biases
convert bias -out=../../process
cd ../../process
stack bias rej 3 3 -nonorm -out=master_bias
cd ..

# ---- Master dark ----
cd raw/darks
convert dark -out=../../process
cd ../../process
stack dark rej 3 3 -nonorm -out=master_dark
cd ..

# ---- Master flat ----
cd raw/flats
convert flat -out=../../process
cd ../../process
calibrate flat -bias=master_bias
stack pp_flat rej 3 3 -norm=mul -out=master_flat
cd ..

# ---- Calibrate, register, stack lights ----
cd raw/lights
convert light -out=../../process
cd ../../process
calibrate light -dark=master_dark -flat=master_flat -cc=dark -cfa -equalize_cfa -debayer
register pp_light
stack r_pp_light rej 3 3 -norm=addscale -output_norm -out=result
close
```

Notes for whoever templates this in Python (see gotcha #2/#3 above for why
the `raw/` staging layer exists at all — don't collapse it away):
- All four frame types convert into the same `process/` dir — matches the
  official Siril `OSC_Preprocessing.ssf` convention, not an invented layout.
- `-cc=dark -cfa -equalize_cfa -debayer` on the light calibration line are
  OSC-specific (this camera is Bayer/RGGB). A mono-camera path would drop
  `-cfa`/`-equalize_cfa`/`-debayer`.
- The "few different stacking algorithms" knob Chris wants in the web UI
  is the `stack ... rej 3 3 ...` line — swap `rej 3 3` for another Siril
  rejection method, that's the whole parameterization surface.

## Immediate next steps
Steps 1–3 from the prior handoff (split masters/lights phases into
Python, reference rolandet's master-builder scripts, FastAPI skeleton
with render/run + background jobs) are **done** — see "Current validated
status" above. What's next:

1. Parse siril-cli's `progress: N%` log lines in `jobs.py`/`Job` into a
   proper `percent_complete` field on `/jobs/{id}` (the raw line is
   already captured as `current_line`; this is just extracting the number
   and exposing it more usefully) — closes the gap on the Endstate's
   "aware of steps/percentages/time" requirement.
2. Run the multi-night (`merge`) path against real multi-night capture
   data at least once — it's only been render-tested so far, never
   actually executed through siril-cli.
3. Wrap project creation + `stage_captures.sh` in an endpoint (e.g.
   `POST /projects/{name}` that stages from `/captures`) so a project
   doesn't require manual shell setup before the API can touch it.
4. Research Siril's actual `crop` syntax against a real registered
   frame's dimensions (region-based `x y width height`, not a
   margin-trim) before wiring it in — don't guess at this one.
5. Frame review/filtering (FWHM, star count, eccentricity, SNR) and
   archival/cleanup are still fully unstarted — they're the two Endstate
   bullets with no design work behind them yet.