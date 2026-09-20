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
  execution + log streaming, not a blocking HTTP request. Not yet built.
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
- ❌ Master-building not yet factored into its own reusable script/module
  (it's currently inline in the one combined `.ssf` below) — worth
  splitting into a "build masters" step and a "calibrate/register/stack
  lights" step once this becomes Python, since a real workflow will often
  reuse the same masters across multiple stacking runs rather than
  rebuilding them every time.
- ❌ No Python/FastAPI code written yet. `scripts/stage_captures.sh` is the
  only repo code so far, and it's shell, not Python.
- ❌ No `crop` step yet (trims the ragged registration border) — left out
  of the first full test deliberately to keep troubleshooting simpler.
  Add it once the Python version is running.

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
1. Split the validated script above into two logical phases in Python:
   build-masters (bias/dark/flat) and calibrate-register-stack (lights) —
   masters get reused across runs, lights don't.
2. Adapt `make_master_darks_auto.py`/`make_master_biases_auto.py` from
   rolandet's repo for reference on how someone else structured this same
   split, rather than designing it from zero.
3. FastAPI skeleton — `/build` (render `.ssf`, don't run) and `/run`
   (execute + stream log), background job execution for long stacks.
4. Add the `crop` step once the Python version is running end-to-end.