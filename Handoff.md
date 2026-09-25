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
- **Versioning started 2026-09-23**: `config.VERSION` (`app/config.py`,
  a single hand-bumped string) is the one source of truth, surfaced via
  `GET /health`'s `version` field, `FastAPI(version=...)` (shows in
  `/docs`), and the UI header (`#app-version`, populated from `/health`
  in `app.js`'s boot sequence). Versions correspond 1:1 with pushes that
  actually trigger the CI build (`.github/workflows/docker-publish.yml`
  — confirmed against GitHub's own Actions run history, not guessed at:
  3 runs existed at the time this started, for commits `b9954ba`
  (CI+Dockerfile), `91b2dc9` (Masters/Stack redesign + narrowband), and
  `e75349d` (camera/date mismatch warnings) — Chris named that 3rd one
  **v0.3** retroactively (tagged in git), making the next push **v0.4**.
  **Stay under 1.0 deliberately** until Chris has run this in production
  long enough to trust it — his call to make, not tied to any feature
  list or date. Bump `VERSION` by hand as part of whatever commit is
  about to be pushed next; tag the release (`git tag -a vX.Y <sha> -m
  "..."`, `git push origin vX.Y`) once it's actually pushed.
- **Option A**, not B: the tool builds masters from raw calibration subs
  itself, rather than only consuming pre-built masters. Chris explicitly
  chose this.
- Backend: FastAPI, templates `.ssf` scripts, shells out to `siril-cli`.
  No sirilpy live-session integration — headless CLI only. **Exception:
  `/lights/analyze` (frame quality review) uses `astropy`+`photutils`
  directly in Python instead, added 2026-09-2x** — see the dedicated
  bullet below. Calibration/registration/stacking stay on Siril; it's
  validated and does real geometric-transform/stacking work not worth
  reimplementing.
- No file-browser UI for v1 — typed directory paths. **Superseded
  2026-09-2x**: `/captures/browse` (Stage's folder pickers) and
  `/projects/{name}/browse` (Stack's master-override file pickers) give
  basic pickers now, and every directory/file field in the frontend is
  `readonly` — a picker button is the only way to set them, no typed
  paths anywhere anymore (no breadcrumbs in either picker yet — see
  Immediate next steps). Still wanted eventually: pulling lights/flats
  from a telescope controller, darks/biases from a server, and archiving
  files once done.
- **Frontend: plain HTML/CSS/JS in `app/static/`, no build step, no
  framework** (settled 2026-09-2x). Chris asked for astrolab's dark
  card-based *styling* but this project's own *functionality* — closer to
  Siril's own OSC Multi-Night Stacking tool (stage -> masters -> review ->
  stack), not astrolab's much bigger pipeline (BG Extract/Denoise/Color
  Balance are explicitly out of scope — see the Endstate/"raw stack" and
  crop decisions). Served directly by FastAPI (`StaticFiles` mounted last
  in `app/main.py`, so it never shadows an API route). No React/Vue/build
  tooling — matches the project's own minimalism (single repo, one
  maintainer, CPU-only NAS box) and keeps the whole thing inspectable as
  plain files. Revisit only if the UI's complexity genuinely outgrows
  this, not preemptively.
- Long-running jobs (stacking can take an hour+) need background
  execution + log streaming, not a blocking HTTP request. Built as a
  minimal in-thread job manager (`app/jobs.py`) — good enough for a
  single-user, single-process app; swap for a real queue only if that
  stops being true.
- GPU: CPU-only (`:cpu`, no NVIDIA Container Toolkit on this box).
- Single repo, not split into "app" + "container" repos — one maintainer,
  one deployable, no independent lifecycle for the Dockerfile.
- **No crop, ever, before stacking is complete** (settled 2026-09-20, not
  just deferred): the Endstate is the raw stacked `.fit`. Cropping the
  ragged registration border — like all other post-processing (stretch,
  color, star removal) — happens in other software, downstream of this
  tool. Don't relitigate adding a crop step "once it's easy"; it's out of
  scope by design, not by lack of time.
- **Bias/dark are shared across the whole project; flats are per-night.**
  Chris: "usually a single set of bias and dark images that will apply
  across all nights... for each night, there should be a unique set of
  lights and their matching flats." `process/master_{bias,dark}.fit` are
  always project-wide; `process/nights/<name>/master_flat.fit` is built
  per night. Don't collapse this back to one shared flat for "simplicity"
  — sky conditions/dust change night to night, which is the whole reason
  flats get retaken.
- **Frame review recommends, never auto-filters.** Chris: "we want to
  provide recommendations, but not automatically filter anything out"
  (asked for something in the spirit of astropup-blink — a per-frame
  quality *inspector*, not an auto-reject step). `/lights/analyze`
  computes and returns FWHM/roundness/background/star-count per frame and
  excludes nothing; a human picks `exclude_frames` for `/stack/run`
  afterward. Don't add an auto-reject threshold later without Chris
  explicitly asking for one — it would invert this decision.
- **Anomaly flagging is relative to each night's own data, never a fixed
  cutoff.** Chris, after sending a real astropup-blink screenshot: "the
  key is looking for anomalies in the data, not fixating on particular
  numbers as cutoffs." `app/framestats.py`'s `flag_anomalies()` computes a
  robust (MAD-based) z-score per metric against the REST OF THAT NIGHT's
  own frames — never an absolute FWHM/star-count/etc. number — matching
  both that direction and astropup-blink's own per-metric outlier
  presentation against a sequence's own distribution. Validated against
  real known-bad frames Chris identified by eye (a 7-frame dawn-twilight
  ramp and a subtler elevated-background frame) before this was built —
  see "Current validated status." Don't replace this with fixed
  thresholds later without a specific reason; it would contradict this
  direction and the "recommend, don't auto-filter" one above. **The
  z-score threshold itself is tunable** (`anomaly_sigma`, default 3.0 —
  Chris asked "is 4.69 really that much worse than 4.62 for FWHM?"), and
  the frontend recomputes which frames count as flagged client-side from
  the z-scores it already has (`isFrameFlagged()` in `app.js`) so a
  slider drag re-colors instantly with no re-analyze round trip — this is
  still the same relative-to-the-night's-own-data z-score, just a
  user-adjustable cutoff on it, not a step back toward a fixed number.
- **`/lights/analyze` uses astropy+photutils directly, not Siril**
  (settled 2026-09-2x). Cause: a real, confirmed performance cliff running
  multiple sequences in one Siril session (gotcha #8) — identical
  calibrate+register work took 10s alone vs 90s as the second sequence in
  one `siril-cli` process, and it compounds with more nights. Chris asked
  to look at astropy/photutils as an alternative before accepting a
  subprocess-per-night workaround; research + benchmarking against real
  capture data showed pure-Python analysis is both immune to the problem
  (stateless numpy per frame, no subprocess to degrade) *and* faster
  outright (see `app/framestats.py`'s docstring for the numbers). This
  fully replaced the Siril-based analyze path, not just patched it — see
  "Current validated status." Calibration/registration/stacking are
  untouched; this is scoped to the review step only.
- **No separate single-night layout** (settled 2026-09-20, replacing an
  earlier design that had one): every project always uses
  `raw/nights/<name>/{lights,flats}`, even for a project with exactly one
  night. The earlier dual-layout design (an implicit flat `raw/lights` for
  "single-night", `raw/nights/<name>/...` for "multi-night") caused a real
  bug in practice — Chris hit it directly: staging `multi1` only ever
  created the `raw/nights/...` layout, so a request with no `nights`
  specified silently assumed the *other* layout and failed with a
  confusing "directory not found" instead of a clear error. `nights` is
  now a required, non-empty field everywhere (`Field(..., min_length=1)`)
  — a missing/empty list is a clean 422 from FastAPI itself, not a guess.
  The only place night-count still matters is whether the final
  register/stack step needs `merge` first (see gotcha #7 — Siril's
  `merge` refuses fewer than two inputs, so exactly one night can't use
  the same code path as two+); the on-disk layout itself never varies.
- **No more file-management scope than what already exists** (settled
  2026-09-2x). Chris is building a *separate* tool that pulls data off
  his telescope controllers, sorts it, and archives it under its own
  naming convention — this app comes in *after* that, purely to
  calibrate/stack. Don't add features that overlap with that job (import
  automation, sorting/renaming captures, archival) — remove-a-night and
  whole-project-delete (see below) are the ceiling for file management
  here, not a first step toward more. One specific idea explicitly
  flagged as **future work, not started, needs real design thought**:
  actually *deleting* an obviously-bad frame from Review rather than
  just excluding it. Not built because `CAPTURES_DIR` is a read-only NAS
  mount (gotcha #2) — a raw light lives there, not in the project's own
  `raw/` (which only holds symlinks into it), so "delete" can't just be
  `rm` on the symlink; it would need to either delete through to the
  read-only mount (requires it to stop being read-only, a bigger
  decision) or repoint the symlink at some kind of quarantine location
  that isn't `CAPTURES_DIR` itself. Don't build this without deciding
  that architecture question first.

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
- `rolandet/siril-scripts`' `osc-multi-night-stacking-v1.2.py` (a PyQt6
  desktop app, not something to port wholesale) has a `SirilCommandBuilder`
  class showing the `merge`-based multi-night pattern this project's
  multi-night stacking follows structurally (per-session `pp_light`, then
  `merge "session/pp_light" ... all_sessions`) — referenced for that
  pattern only, not copied; this project stays headless-CLI/.ssf, not
  sirilpy.
- **astropup-blink** (`astropup.app/#app-blink`, Chris's UX reference for
  frame review) — its live page wasn't fetchable when first researched
  (2026-09-20, a JS-rendered SPA that returned nothing to a plain fetch),
  but Chris later sent a real screenshot (2026-09-2x) of it reviewing
  Night 2's data. What it shows: a top bar (`All 17 / ✓10 / ⚠7`), four
  per-metric panels (Star count, FWHM, Eccentricity, SNR) each a per-sub
  bar chart with an "Auto" threshold toggle highlighting the outlier bars
  for THAT metric against the rest of the sequence — not a fixed absolute
  cutoff — plus a session timeline, and a large two-up image preview
  ("blink" comparator) below, one of which visibly showed a satellite/
  plane trail. This directly informed `flag_anomalies()`'s design
  (per-metric, relative-to-the-sequence flagging — see Architecture
  decisions) and confirmed the "7 flagged" in the screenshot lines up with
  a real 7-frame dawn-twilight ramp in the actual capture data. Image
  preview generation now exists and then some (thumbnails, a zoom/pan
  lightbox, prev/next frame navigation — see "Current validated status"),
  but it's still one-at-a-time, not astropup's actual two-up side-by-side
  "blink" comparator (flip rapidly between two specific frames to spot a
  difference like a satellite trail) — nobody's asked for that specific
  interaction since, so it's not planned, just noted as the one thing
  from this reference that isn't replicated. Also still not replicated:
  SNR-panel-style spatial background maps (`app/framestats.py` uses a
  single global background/std per frame, not `Background2D`'s 2D map).
- **Siril's `.seq` registration-data format** (undocumented anywhere
  found — reverse-engineered from real output): after `register`, a `R<layer>`
  line per frame holds `fwhm wfwhm roundness quality background nb_stars`,
  in that column order — confirmed by matching 1:1 against `seqapplyreg`'s
  documented filter flags (`-filter-fwhm/-filter-wfwhm/-filter-round/
  -filter-quality/-filter-bkg/-filter-nbstars`). `quality` has read `0` for
  every frame tested so far (deep-sky Global Star Alignment doesn't seem
  to populate it). **No longer used** — this was parsed by `app/seqstats.py`
  for the original Siril-based `/lights/analyze`, since replaced by
  astropy+photutils (see Architecture decisions); `app/seqstats.py` was
  deleted along with it. Keeping this note in case `.seq` introspection is
  ever needed again for something else (e.g. stacking progress).

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
6. **`calibrate` (and presumably other sequence commands) rescans its
   *entire* cwd by filename pattern, not just the sequence it was just
   handed.** Confirmed the hard way (2026-09-20) building `/lights/analyze`:
   re-running an excluded-frame review against a `process/` directory that
   still had a *previous* run's `light_00001.fit`...`light_NNNNN.fit`
   sitting in it caused Siril to silently rebuild `light_.seq` from
   *whatever numbered files it found on disk* — mixing this run's fresh
   conversions with the last run's leftovers — then fail trying to open
   frames that no longer existed. This has nothing to do with the
   exclude-frames feature specifically; it will bite *any* repeated
   `convert`/`calibrate` into a directory that isn't cleared first.
   **Consequence:** light conversion/registration/stacking now happens in
   a disposable per-run workspace (`process/lights/` for single-night,
   `process/nights/<name>/lights/` per night for multi-night, plus
   `process/lights/_merged/` for the final multi-night merge/register/
   stack step) that gets fully wiped and recreated — not just `mkdir -p`'d
   — before every run, via `app/ssf.py`'s `prepare_fresh_dirs()`
   (`shutil.rmtree` + recreate). This is deliberately a *separate*
   directory from wherever that scope's master files live
   (`process/master_{bias,dark}.fit`, `process/nights/<name>/master_flat.fit`),
   which must never be wiped. **`/masters/run` now has the same fix
   (2026-09-2x)**: bias/dark/each night's flat each build in their own
   disposable `process/_build/...` scratch dir, wiped fresh every run,
   with the final master moved to its stable location only after that
   step's siril-cli process exits successfully (`app/ssf.py`'s
   `perform_move()`). Verified by rebuilding masters twice in a row
   against `multi1`'s real data — both runs succeeded identically.
7. **`merge` refuses to run with fewer than two input sequences** — its
   own usage string is `merge sequence1 sequence2 [sequence3 ...]
   output_sequence`; `sequence2` is not optional. Confirmed the hard way
   (2026-09-20) trying to unconditionally merge-then-stack regardless of
   night count, to see if it would collapse the single/multi-night
   branching entirely. It can't: a project with exactly one night must
   skip `merge` and register/stack that night's own `pp_light` sequence
   directly. `app/ssf.py`'s `_resolve_nights()` handles this by making the
   merge step conditional purely on `len(nights) > 1` — this is the *only*
   place single-vs-multi still matters; the on-disk layout itself is
   identical either way (see the "no separate single-night layout" note
   below).
8. **Running multiple sequences' `calibrate`+`register` in one Siril
   session gets progressively, dramatically slower — not just additively
   slower.** Confirmed with real timing (2026-09-2x, `/lights/analyze`
   against real two-night data): identical calibrate+register work on the
   same 10 frames took 3.02s+7.08s=10.27s in isolation, but 42.38s+48.17s
   =90.55s when run as the *second* sequence in the same `siril-cli`
   process right after a first one — an ~8.8x slowdown for the same work,
   confirmed NOT to be about the specific data (isolating night2 alone
   reproduced the fast time). Root cause not confirmed against Siril's
   source, but "up to N threads can be used" gets reprinted before every
   `register`, suggesting it re-evaluates available memory/thread
   headroom each time and finds less of it left over from the previous
   sequence's ~3GB of registered-image writes. **Consequence #1: this is
   why `/lights/analyze` no longer uses Siril at all** — see the
   architecture decision above and `app/framestats.py`. **Consequence #2
   (2026-09-2x): `/stack/run` and `/masters/run` no longer run multiple
   sequences in one Siril session either.** Each night's calibrate step
   (and each master type — bias/dark/each night's flat) now runs as its
   own separate `siril-cli` subprocess, orchestrated by
   `jobs.create_multi_script_job()` (`app/jobs.py`'s `ScriptStep`) — see
   `app/ssf.py`'s `render_build_masters()`/`render_stack_lights()`, which
   build the step list instead of one combined script. The *final*
   register+stack step for a multi-night project is the one place this
   still can't be split further (merge/register/stack genuinely need
   every night's data in one Siril session at once) — acceptable since
   gotcha #8's cost comes from *repeated* calibrate+register cycles, and
   that final step only ever calls `register` once regardless of night
   count.
9. **`shutil.move()` relocates a file — it does not leave a copy behind.**
   Not actually a Siril gotcha, but hit implementing gotcha #6's fix for
   masters: the first version had a flat-build step read the shared
   master bias back from the *bias step's own scratch dir*, reasoning
   the scratch copy "isn't deleted, only copied/renamed" once moved to
   its stable location — wrong; `shutil.move()` is a real move (rename on
   the same filesystem), so the scratch file was already gone by the time
   the flat step ran, and `calibrate` failed with "invalid arguments."
   Fixed by having later steps reference the STABLE destination path
   instead (safe here because steps run in a fixed order — bias's move
   always completes before any flat step starts).
10. **Editing any file under `app/` while a job is mid-run kills that
    job's tracking, but not the underlying `siril-cli` process.**
    `uvicorn --reload` watches the whole `app/` directory; any edit
    (including one totally unrelated to the running job) restarts the
    Python process, wiping the in-memory `_jobs` dict (`app/jobs.py`).
    The actual OS subprocess already spawned via `subprocess.Popen`
    doesn't get killed by this — it's reparented to PID 1 and keeps
    running to completion, writing its log file same as always, but
    `/jobs/{id}` returns 404 for it from that point on since the tracking
    object is gone. Hit this for real (2026-09-2x) mid-testing a ~28-frame
    stack. Not a bug to "fix" so much as a dev-workflow trap: avoid
    editing `app/` files while watching a long job's progress through the
    API; if it happens, the job's actual result can still be found on
    disk (check `process/.../result.fit` and the job's log file directly)
    even though the API can no longer report on it.
11. **Manually restarting uvicorn from outside `--reload` (e.g. after an
    edit that isn't auto-picked-up, or to clear stuck state) can't be
    done by grepping `/proc/*/cmdline` for "uvicorn".** `--reload`'s
    actual request-serving process is a `multiprocessing`-spawned child
    whose cmdline shows as `python3 -c "from multiprocessing.spawn import
    spawn_main; ..."` — nothing resembling "uvicorn" appears in it at all.
    Any substring-match kill script (including matching a hardcoded path
    like `/usr/local/bin/uvicorn`) either misses it or self-matches (a
    `python3 -c "<script text containing the search string>"` finds
    itself). The reliable way: read `/proc/net/tcp`, find the hex-encoded
    port (`8000` = `1F40`) to get its socket inode, then scan every
    process's `/proc/{pid}/fd/*` for a symlink to `socket:[<inode>]` — that
    PID is unambiguous regardless of what its cmdline looks like.
12. **Siril 1.4 always tries to prepare its own internal Python virtual
    environment during `calibrate`, and always fails, harmlessly, in this
    container.** Chris spotted `log: Preparing python virtual
    environment: /root/.local/share/siril/venv` and `Warning: unable to
    install or update the Siril python module` scrolling by during a
    masters build and flagged it as suspicious. This is Siril 1.4's own
    bundled Python scripting feature (`sirilpy`/`pyscript`) trying to
    set itself up automatically on every `calibrate` call — completely
    unrelated to this app's own Python/FastAPI backend, and never
    actually invoked by anything in our `.ssf` scripts (no `pyscript`
    command is ever used). It fails because the AppImage doesn't ship a
    `pyproject.toml` in this headless Docker environment
    (`Failed to install Python module: Failed to open file
    "pyproject.toml": No such file or directory`), logs a warning, and
    then immediately continues into the actual calibration work
    normally — confirmed by reading the surrounding log lines, which show
    "Preprocessing: processing..." and real per-frame corrections right
    after the warning. Pure noise; don't waste time chasing it again.

## Frontend/web gotchas (do not rediscover these either)
Found building `app/static/` (2026-09-2x) — Python/browser issues, not
Siril ones, but the same "don't rediscover this" spirit applies.

1. **`Path.resolve()` follows symlinks — don't use it for a
   traversal-safety check on a path that's *supposed* to point outside
   the directory you're checking containment against.** The first version
   of `GET /projects/{name}/preview` resolved the requested path and
   checked the RESOLVED path was under the project dir. Every raw light/
   flat under `raw/` is itself a symlink into `CAPTURES_DIR` by design
   (`app/staging.py`) — so its resolved target is *never* under the
   project dir, and every single raw-frame preview request was rejected
   with "path escapes project directory." Fixed by checking the
   LEXICAL path instead (reject `..` components / absolute paths in the
   untrusted string) and letting `open()`/`is_file()` follow the symlink
   naturally — the security property that actually matters (can't read
   `../../etc/passwd`) doesn't need symlink resolution to enforce.
2. **`<img loading="lazy">` triggers on proximity to the *viewport*, not
   to a scrolling ancestor container.** The Review section's frame strip
   scrolls horizontally (`overflow-x: auto`); images past the initially
   visible ~6 cards never entered the viewport itself, so lazy loading
   correctly-by-spec never fired for them — they just sat "loading"
   forever until a user happened to scroll the strip. Confirmed via a
   scripted browser test (7/11 loaded, stuck indefinitely; scrolling the
   strip to the end immediately loaded the rest). Fixed by dropping
   `loading="lazy"` for these thumbnails — predictable "everything loads
   when analysis completes" beats saving bandwidth on a review screen
   with at most a few dozen frames.
3. **Decoding a full-resolution FITS array just to make a 320px
   thumbnail wastes the expensive part of the work.** `PIL`'s
   `.thumbnail()` only shrinks the *output* — the percentile/stretch
   computation (`app/imaging.py`) still runs over the full ~26M-pixel
   array first. Fixed the same way `app/framestats.py` did for analysis
   speed: stride-downsample the array *before* the stretch, sized to the
   requested `max_size`. The frontend requests `max_size=320` for the
   review grid and the full default (1024) for the one large stack
   result preview.
4. **Two overlapping `/masters/run` or `/stack/run` calls against the same
   project race on the same scratch directories.** Found by accident
   while testing the redesigned frontend (2026-09-2x): fired a stack run,
   then fired a second one against the same project before the first
   finished. The second call's `ssf.prepare_fresh_dirs()` tried to
   `shutil.rmtree()` a `process/nights/.../lights` dir the *first* run's
   still-live `siril-cli` subprocess was actively writing into ->
   `OSError: [Errno 39] Directory not empty`, an unhandled 500. Not fixed
   at the API level (the job manager has no per-project lock) — mitigated
   in the frontend instead: `app.js`'s `pollJob()` now disables the
   triggering Run/Analyze button for the duration of that job
   (`lockButtons` option), so a normal double-click or a second click
   after navigating away and back can't trigger this through the UI.
   Two different browser tabs, or a Swagger UI call made while the
   frontend also has a job running, still could — **closed 2026-09-2x**
   by `_reject_if_job_running()` in `app/main.py`: `/masters/run` and
   `/stack/run` now 409 if `jobs.has_running_job()` finds any job already
   running for that project, from any client. The frontend also polls
   `GET /jobs` (global, every 5s, from page load — not gated on a project
   being open, see the global active-jobs panel in "Current validated
   status") and disables both buttons for the currently-open project the
   moment it sees anything running there from elsewhere — best-effort/UX
   only (up to ~5s to notice), the 409 is the actual guarantee.
5. **HEAD requests 404 across this entire FastAPI app, not just one
   route.** Discovered testing the new download button with
   `fetch(url, {method: "HEAD"})` — got a 404 with Starlette's generic
   `{"detail":"Not Found"}` body. Confirmed with `curl -I` against
   `/health` itself: same 404. This is a property of the FastAPI/
   Starlette versions pinned in this container, not a bug in any one
   endpoint — GET still works normally (verified: `GET /projects/{name}/
   download` returns 200 with correct `content-disposition`/
   `content-length`/`accept-ranges` headers and the real file body). A
   real browser download link (`<a href>` click, or `curl` with no
   `-I`/`-X HEAD`) always issues GET, so this doesn't affect actual
   users — just don't waste time debugging a "download is broken" report
   that turns out to be a HEAD-based health check or test script.
6. **A real, structural color bug lived in `_BAYER_OFFSETS`
   (`app/imaging.py`) since debayering was first added: B and the second
   green sample (G2) were transposed in every one of the four pattern
   entries.** For RGGB specifically, the code listed `(1,0)` as B and
   `(1,1)` as G2 — backwards; the actual RGGB tile (reading the name
   literally, row-major) is R(0,0) G(0,1) G(1,0) B(1,1). Every debayered
   preview (both the original block-mean version and the later bilinear
   one) was therefore averaging real G with real B into its "G" output
   and emitting pure G as its "B" output — a wrong-channel bug, not a
   stretch or rendering issue. Caught while chasing an unrelated
   checkerboard artifact Chris spotted on master flat thumbnails: the
   demosaiced G channel showed values alternating ~0.29 vs ~0.87, while
   the raw mosaic's actual two green sub-samples measured almost
   identical means (0.586 vs 0.587) — a 3x internal discrepancy only
   possible if one of the code's "G" positions was actually reading B.
   Fixing the four tuples resolved *two* separately-reported symptoms at
   once: the checkerboard on flats, and a persistent turquoise/cyan color
   cast on review light thumbnails Chris had separately flagged as
   "we may have lost our unlinked stretch" — the stretch parameter was
   fine the whole time; the underlying color channels were wrong.
   Verified via raw pixel inspection before/after and a full visual
   re-check of both a flat and a light preview. See "Current validated
   status" for the fix and `_block_average()`, a smaller, genuinely
   secondary issue (naive strided downsampling has no anti-aliasing)
   found and fixed in the same pass.

## Current validated status
- ✅ **One fix and three additions from live-usage feedback, verified
  end-to-end (2026-09-2x)**: 1) **fix: review results didn't survive
  switching projects and back.** Chris: "Light frame images do not stay
  visible when I move between projects." Root cause: `state.
  lastAnalyzeResult` (and exclusions/sensitivity) are pure client-side
  state, unconditionally reset on every project switch — by design,
  since none of it is saved server-side (see `AnalyzeLightsRequest`'s
  docstring), but that meant switching away to check something else and
  back threw the whole review session away even for a project analyzed
  moments earlier. Fixed with a client-side `reviewCache` (`app.js`),
  keyed by project name: the outgoing project's analyze result/
  exclusions/sensitivity are saved just before a switch and restored
  (after `loadProjectStatus()`, so `is_osc`/debayering is already known)
  on return — explicitly invalidated by "Start over" and by deleting the
  project, so neither can resurrect stale data. Verified end-to-end
  (analyze, switch away, switch back, confirm images load with correct
  `naturalWidth`) after ruling out a red herring: the first repro
  attempts failed because the `multi1` test project referenced
  throughout this file no longer exists — deleted at some point during
  this session's own testing, not a product bug;
  2) **global "active jobs" panel** — Chris: "if I'm running a stack in
  two separate projects, I shouldn't have to go clicking through
  projects to see what's happening." New `GET /jobs` (`app/main.py`,
  backed by `jobs.list_all_jobs()`) lists every job across every
  project; a panel visible regardless of which (if any) project is
  selected (`pollActiveJobs()`/`renderActiveJobsPanel()` in `app.js`,
  polling every 5s from page load, not tied to project selection like
  the per-project version it replaces) shows every currently-running
  one, each row clickable to jump straight to that project. The
  per-project Masters/Stack button-disable and 409-avoidance behavior
  from the prior round is preserved, now driven by this same global
  poll filtered to `state.project` rather than a separate per-project
  poll; 3) **broken-symlink detection** — Chris: "we should be aware if
  the symlinks in the captures folder are invalid... if this check is
  going to slow response time too much, let's come up with a better
  solution." New `GET /projects/{name}/broken-links` walks every
  symlink under `raw/` and checks whether its target still exists (one
  stat-like syscall per staged file) — deliberately its own endpoint,
  not folded into `/status`, and called fire-and-forget (not awaited)
  right after `loadProjectStatus()` so a slow check on a huge project
  can never block the fast/essential status load or anything else from
  rendering; shows an amber banner listing what's missing if anything
  comes back broken. Verified detection against a deliberately broken
  symlink (real target replaced with `/nonexistent/fake.fit`); 4)
  **filename-type mismatch warnings at Stage time** — Chris: "if the
  filenames don't indicate an appropriate image type, we should warn
  the user. This should look the same as the mismatched lights/flats
  warning." `_detect_frame_type()` (`app/main.py`) checks `/captures/
  browse`'s filenames (case-insensitive) for "light"/"dark"/"flat"/
  "bias" keywords — most capture software puts the type right in the
  name (confirmed against this project's own real filenames, e.g.
  `Light_ElephantTrunk_300.0s_..."`) — and returns the dominant type, or
  "mixed" if inconsistent, or `null` if it can't tell (never warns in
  that case — nothing to warn about is different from "no files match a
  keyword"). The frontend compares this against what each field expects
  and shows the same `.session-mismatch-warning` styling already built
  for the lights/flats-parent check, combined into one message when both
  issues apply at once. Verified: pointing "Darks dir" at the biases
  folder correctly warned "looks like it contains bias frames, not
  darks."
- ✅ **Job history + cross-tab/cross-client job awareness implemented and
  verified against a real ~10+ minute stack run (2026-09-2x)** — the
  cross-tab piece described here is superseded by the global version
  directly above (same underlying mechanism, now project-agnostic); job
  history itself is unchanged.
  Immediate next steps items 1 and 2: `app/jobs.py`'s `Job` dataclass
  gained `project`/`kind` fields (threaded through all three
  `create_*_job()` functions and every call site in `app/main.py`);
  `has_running_job(project)` checks for any job (any kind, any client)
  currently `"running"` for a project; `list_jobs(project)` returns all
  known jobs newest-first. New endpoint `GET /projects/{name}/jobs`
  backs both features. **Job history**: a "🕐 Job history" button opens a
  panel listing every job run for the current project since the server
  last started (not persisted to disk — same in-memory lifetime as
  `_jobs` always had), each row expandable to its full log
  (`renderJobHistory()` in `app.js`). **Cross-tab awareness**: `/masters/
  run` and `/stack/run` now return 409 if `has_running_job()` finds
  anything already running for that project (`_reject_if_job_running()`)
  — a real server-side close of Frontend/web gotcha #4's race, not just
  the existing same-tab button-disabling. The frontend polls `GET
  /projects/{name}/jobs` every 5s while a project is open
  (`startCrossTabPoll()`); if it finds a running job (started from this
  tab, another tab, or a raw API call), it shows a banner with live
  progress and disables both Masters/Stack run buttons project-wide, and
  auto-refreshes project status the moment nothing is running anymore.
  Verified for real: opened the frontend fresh while a stack job I'd
  started via curl was already ~mid-run — banner and disabled buttons
  appeared on first load (not just after starting a job from that tab),
  and a second `/stack/run` call while it was running got a real 409.
- ✅ **Confirmation warning for mismatched lights/flats folders**
  (2026-09-2x, new task, not from the prior gap list — Chris: "if the
  user misclicks and selects night 1 lights and night 2 flats, we should
  warn them... they should still be able to do it"). Each session row in
  Stage now shows an inline amber warning the moment its lights and flats
  folders have different PARENT directories (`checkMismatch()` in
  `app.js`, wired via a new optional `onSelect` callback on
  `attachFolderBrowser()`) — not a hard block, matching the "still
  possible, just flagged" requirement (e.g. deliberately reusing one
  night's flats for another remains fully supported, just without the
  warning if you happen to pick folders with the same parent name for
  an unrelated reason — a heuristic, not a strict identity check).
  Verified: picking `Night 1/lights` + `Night 2/flats` shows the warning;
  correcting to `Night 1/lights` + `Night 1/flats` clears it.
- ✅ **Fixed the real Bayer B/G2 channel-position bug and a secondary
  aliasing issue** — see Frontend/web gotcha #6 for the full story
  (`_BAYER_OFFSETS` had B and G2 transposed in every pattern since
  debayering was first added; `_block_average()` replaced naive strided
  downsampling, which has no anti-aliasing). Resolved two separately-
  reported symptoms at once: a checkerboard pattern on master flat
  thumbnails and a turquoise/cyan color cast on review light thumbnails.
- ✅ **Four "Immediate next steps" items completed in one round, plus a
  real bug found and fixed along the way (2026-09-2x)**: 1) **UI hint for
  cross-night frame exclusion** — a one-line note added to the Stack
  step's excluded-frames field explaining it applies across every
  selected night, not just one; 2) **real (bilinear) debayer algorithm**
  — `_debayer_bilinear()` replaces `_debayer_block_mean()` in
  `app/imaging.py`: each missing Bayer-mosaic sample is now a proper
  weighted average of its real same-channel neighbors (`[[1,2,1],
  [2,4,2],[1,2,1]]/4` for R/B, `[[0,1,0],[1,4,1],[0,1,0]]/4` for G —
  standard bilinear-demosaic kernels, verified by hand against actual
  Bayer tile positions), implemented as pure-numpy shifted-slice
  convolution (`_convolve3x3()`) rather than adding scipy as a
  dependency. Produces full native resolution (verified: 6248x4176 out,
  matching the sensor, vs. the old block-mean's implicit half-resolution
  output) with visibly better quality — round stars, faint nebulosity
  already visible in a single unstacked sub, no color-fringing
  artifacts; 3) **lightbox nav staleness fixed** — `lightboxNav` no
  longer snapshots a frame-list array at open time; `currentLightboxFrames()`
  recomputes the live (survivors-only-filtered) list from
  `state.lastAnalyzeResult` on every navigation, and the current frame is
  tracked by filename (a stable identity) rather than a numeric index
  into a now-possibly-stale array. If the currently-viewed frame drops
  out of the live list (e.g. you exclude it via the lightbox's own
  checkbox, then switch on survivors-only), it lands on the nearest
  neighbor instead of showing wrong data — verified exactly this
  sequence against real data; 4) **large-night collapsing validated
  against real data** — Chris added real bulk captures (Night 2 grew to
  110 real lights, 5.9GB). Staged and analyzed for real: the >20-frame
  collapse behavior worked correctly (110 frames → 24 visible cards + 2
  expandable "N more" groups, expanding one correctly grew to 85 visible
  without disturbing the other), and the real data's own anomaly cluster
  (a genuine dawn-twilight run near the end of the night) was visible
  exactly where expected in both the metric graphs and the flagged-frame
  clustering. Found a real, previously-unknown bug during this same
  testing: **`/lights/analyze/run` crashed on any project that had never
  had a Siril-based job (`/masters/run` or `/stack/run`) run against it
  first** — `create_python_job()` (`app/jobs.py`) never created its log
  directory before opening the log file, unlike
  `siril_runner.run_script()` (used by the Siril-based job types), which
  does this itself. A project staged and taken straight to Review (a
  perfectly normal thing to do, since Review needs no masters) had no
  `project/logs/` directory yet and crashed immediately with a bare
  `FileNotFoundError`. Fixed by having `create_python_job()` create its
  own log directory the same way, verified by reproducing the exact
  failure against a freshly-staged project and confirming it now
  succeeds.
- ✅ **Stage no longer assumes "biases"/"darks" as default folder names**
  (2026-09-2x, Chris: "I don't want the app to assume the path to biases
  and darks when a new project is created... in the future I'm going to
  point the captures folder at my entire directory of astrophotos, which
  means it won't be as cleanly organized"). `StageProjectRequest.biases_dir`/
  `darks_dir` now default to `None` (skip) instead of the literal strings
  `"biases"`/`"darks"`, and the frontend's Stage form no longer pre-fills
  those fields — both start empty with a "click … to browse" placeholder,
  same ellipsis-only picker as everywhere else. This was previously a
  reasonable assumption when `CAPTURES_DIR` was a small, purpose-built
  test folder with exactly those two subdirectories; it stops being safe
  the moment it points at a real, less uniformly organized archive.
- ✅ **Two items off the "Immediate next steps" gap list, re-validated
  end-to-end (2026-09-2x)** — Chris picked these two out of item 1's
  bundle of six distinct gaps via an explicit choice, deferring the rest
  (cross-tab polling, job history, large-night testing, a better debayer
  algorithm) rather than have them all guessed at in one unscoped pass:
  1) **remove a single staged night**: new `DELETE
  /projects/{name}/nights/{night}` (`app/main.py`) removes that night's
  `raw/nights/<night>` symlinks and any `process/nights/<night>`
  artifacts (master flat, per-night stack scratch) without touching the
  rest of the project — shared master bias/dark and any already-completed
  merged stack are left alone (a merged result that included the removed
  night becomes stale, same as the existing "exclude frames after
  stacking" situation; nothing tries to detect or clean that up). The
  Stage panel now shows a "Currently staged sessions" list above the
  add-session rows, each with a confirm-gated "✕ Remove" button
  (`renderExistingStagedNights()`). Re-staging afterward no longer risks
  colliding with a night that's still there: `nextNightNumber()` names a
  newly-added session starting after the highest *existing* night number
  rather than always starting from 1 based on the current form's row
  count — verified by removing night2 from a real 2-night project and
  confirming the next session would become night3, not a second night2;
  2) **breadcrumb trail for both folder/file pickers**
  (`/captures/browse`'s and `/projects/{name}/browse`'s UI): replaced the
  bare "← up" button with a clickable path (`renderBreadcrumb()` in
  `app.js`, shared by `attachFolderBrowser`/`attachFileBrowser`) — the
  root segment and every intermediate segment jump straight there, only
  the current (last) segment is non-interactive. Verified navigating
  captures/Night 1/lights three levels deep and jumping back to the
  middle segment in one click.
- ✅ **Three more small frontend fixes, re-validated end-to-end
  (2026-09-2x)**: 1) **the "add a session" row's number was wrong when
  opening a project that already had sessions staged** — Chris hit this
  directly: a project with one staged night showed "Session 1" for the
  next one instead of "Session 2". Two compounding bugs:
  `addNightRow()`'s label only ever counted draft rows already in the
  form (`container.children.length + 1`), never what the project already
  had staged; and on a project switch, `addNightRow()` runs *before*
  `loadProjectStatus()`'s fetch resolves, so even a fix based on
  `state.status` would've read it while still `null` (just reset). Fixed
  by having `addNightRow()`/`renumberSessions()` both use
  `nextNightNumber()` (added for the remove-a-night work above — continue
  after the highest existing night number) instead of a local row count,
  and calling `renumberSessions()` again once `loadProjectStatus()`
  actually knows the real count, on both its success and 404 paths.
  Verified across a 0/1/2-staged-night project each showing the correct
  next number, plus adding/removing draft rows still renumbering
  correctly relative to that base; 2) **the lights vs. flats fields in
  each session row weren't distinguishable once a folder was picked** —
  the only cue was placeholder text ("lights dir (e.g. ...)"), which
  disappears the moment a `readonly` field gets a real value, leaving
  nothing on screen to say which side was which. Fixed by adding a
  persistent "LIGHTS"/"FLATS" label above each field (`.dirpick-group`/
  `.dirpick-label` in `styles.css`) instead of relying on placeholder
  text alone; 3) **master bias/dark/flat preview thumbnails
  (`renderMastersPreviews()`) switched from a "none" to an "unlinked"
  stretch** — Chris asked directly ("I think an unlinked stretch across
  all of them would be helpful to see what the calibration frames look
  like"). Real difference confirmed visually: the master dark now clearly
  shows a per-channel color cast (a pink tint) invisible under the flat
  linear stretch, and the flats show visible dust donuts on top of the
  vignetting gradient that "none" alone hadn't revealed.
- ✅ **Master bias/dark/per-night-flat preview thumbnails** (Immediate
  next steps item 2 — the "no image thumbnails for the stack preview's
  intermediate steps" gap), click-to-zoom into the same lightbox as
  everything else: `renderMastersPreviews()` in `app.js` shows a small
  thumbnail strip in the Masters panel for whichever of master_bias/
  master_dark/each night's master_flat are actually built, debayered the
  same way raw lights are when the project `is_osc` (stretch mode has
  since changed — see the bullet directly above; this entry is kept for
  the rest of what it introduced). No backend changes needed; `GET
  /projects/{name}/preview` already handled any path in the project.
  Extracted `openPlainLightbox()` (reset nav arrows/exclude row, since
  master previews have neither) out of what was inline-only logic on the
  stack preview's click handler, so both share it. Verified against
  `multi1`'s real built masters — flat thumbnails visibly show the
  vignetting gradient, bias/dark show as near-black noise frames, exactly
  the "spot a bad flat before it ruins a night" use case this was for.
- ✅ **Four more small frontend fixes, re-validated end-to-end
  (2026-09-2x)**: 1) "Delete project" is now disabled (with an
  explanatory tooltip) until `loadProjectStatus()` confirms the project
  actually exists on the server — deleting one that's only ever existed
  in the dropdown (added by Create, before Stage ever ran) 404'd;
  2) fixed the lightbox's zoomed image stretching horizontally: the
  base `.lightbox-overlay img` rule's `max-height: 92vh` was still
  capping the rendered height while the zoomed rule forced `width:
  220%`, so two independent constraints fought over one image instead of
  scaling both dimensions together — cleared `max-height`
  (`height: auto` instead) in the zoomed state, verified the rendered
  aspect ratio now matches the natural one to 5 decimal places before
  and after zoom; 3) removed the redundant click-to-browse handler on
  the directory/file `readonly` inputs themselves (Stage's biases/darks/
  lights/flats, Stack's master overrides) — the ellipsis "Browse…"
  button is now the one, unambiguous way in, matching the convention
  Siril's own reference tool uses, rather than two click targets doing
  the same thing; 4) the review lightbox gained prev/next navigation
  (click or arrow keys, hidden appropriately at the first/last frame of
  whatever list it was opened from — respects the current survivors-only
  filter and reaches into collapsed/ellipsis-hidden frames on a large
  night without needing them expanded first) and an "Exclude from stack"
  checkbox synced live with the underlying frame-card's own checkbox and
  the exclude count (toggling it re-renders the review grid behind the
  still-open lightbox via the existing scroll-preserving
  `renderAnalyzeOutput()`). Neither the nav arrows nor the exclude
  checkbox appear when the lightbox is opened from the final stack
  preview, which has no frame list or exclusion to navigate/toggle.
- ✅ **Fixed: switching to a not-yet-staged project showed the
  PREVIOUS project's completed steps (2026-09-2x)**. Chris hit this
  directly: created `live-test-3`, and Calibration Frames/Stack showed
  green-complete with "2 nights staged" even though nothing had been
  staged yet. Root cause: `loadProjectStatus()` only ever reassigned
  `state.status` on a *successful* `/status` fetch — a brand-new project
  name (added to the dropdown by "+ Create," which doesn't touch the
  server until Stage actually runs) 404s there, so the assignment never
  happened and `state.status` silently kept whatever the *previously
  selected* project's status was. The stepper, badges, and night
  checklists all read `state.status`, so they kept showing that other
  project's real completed steps. Fixed two ways: `loadProjectStatus()`
  now catches the fetch failure and explicitly resets `state.status =
  null`, and the project `<select>`'s change handler resets it (plus the
  three badges and three night checklists) immediately and
  unconditionally, before the async fetch even starts, so there's no
  window - however brief, or permanent on a 404 - where stale data from
  another project can render. Verified by reproducing the exact
  sequence (select a fully-complete project, switch to one that's never
  been staged) and confirming everything resets to "not staged."
- ✅ **Third round of frontend fixes, 8 items, re-validated end-to-end
  (2026-09-2x)**: 1) each per-night metric graph now shows an x-axis
  (first/last frame's local time) alongside the existing y-axis min/max;
  2) review thumbnails/lightbox previews use `stretch=unlinked` instead of
  the default `linked` — raw, not-yet-white-balanced subs looked like a
  flat cyan wash under a linked stretch; unlinked (independent per-channel
  black/white points) actually shows the frame; 3) outlier sensitivity is
  now a live-updating range slider pulled out of "advanced options" —
  made possible by computing which frames are "flagged" **client-side**
  from the per-metric z-scores the server already returned
  (`isFrameFlagged()` in `app.js`, replacing every read of the server's
  own `flagged` boolean), since the z-scores themselves don't change with
  the threshold, only which ones count as outliers — dragging the slider
  re-colors everything instantly with no re-analyze round trip; 4) a real
  bug: excluding/re-including a frame lost the frame strip's *horizontal*
  scroll position (distinct from the page's vertical scroll, fixed last
  round) — every re-render throws away and rebuilds each night's
  `.frame-strip` from scratch, and a fresh element always starts at
  `scrollLeft` 0; fixed by capturing each night's scroll position (keyed
  by night, via a new `data-night` attribute) before the rebuild and
  restoring it after; 5) Stack's "OSC / Bayer camera" checkbox removed —
  it re-asked something Chris already answered once at Stage, and now
  `stackBody()` just reads `state.status.is_osc` directly; 6) the final
  stack preview image is now clickable into the same zoom/pan lightbox
  the review thumbnails use, requesting a larger (2400px) render for
  close inspection; 7) a real bug, found from Chris's own report of
  running Rejection then Max then Median back-to-back and getting no
  preview for the 2nd/3rd runs: `stack-run-btn`'s click handler cleared
  `#stack-preview`'s DOM at the start of a new run but never reset its
  `dataset.builtFor` marker — since every stack method writes to the same
  result path, `showStackPreview()`'s "skip rebuilding if this path is
  already built" check (added for the stretch-mode fix two rounds ago)
  saw the unchanged path and skipped rebuilding forever, leaving the
  just-cleared element permanently blank. Fixed by resetting
  `dataset.builtFor` alongside the DOM clear. Verified by actually running
  three back-to-back stacks (rej/max/med) against real two-night data and
  confirming a fresh preview after each one; 8) `DELETE
  /projects/{name}` (new endpoint, `shutil.rmtree` on the project dir —
  safe despite `raw/`'s symlinks into `CAPTURES_DIR`, since `rmtree`
  never follows a symlink into its target) plus a "🗑 Delete project"
  button gated behind typing the project's name back, matching a
  standard "you have to mean it" destructive-delete pattern. All 8
  verified via the same headless-Chrome CDP approach; the delete flow was
  checked against disk (`ls` before/after), the stack-method bug against
  three real successive stacks, not just one.
- ✅ **Second round of frontend polish per 18 more items of live-usage
  feedback, re-validated end-to-end (2026-09-2x)**: 1) Stage's biases/
  darks/lights/flats inputs are now `readonly` — folders can only be
  picked via the ellipsis browser, not typed (clicking the input itself
  also opens the picker, since a read-only text field otherwise looks
  broken); 2) "Next: <step> →" buttons on Stage/Masters/Review advance
  the wizard once that step's prerequisites are met; 3) the script-preview
  toggle's arrow is now a dedicated `<span class="arrow">` sized up in CSS
  (the old version replaced the whole button's `textContent`, which would
  have destroyed that span — fixed to update the span directly); 4) step
  completion is now **always** a small badge in the card header (see
  `setStepBadge()`), matching Stage's original style, instead of Masters'
  old full-width green banner — Masters/Review/Stack all got their own
  `*-status-badge`; 5/5b/5c) the stepper labels are now "File Staging" /
  "Calibration Frames" / "Review Light Frames" (Stack unchanged); 6) an
  `is_osc` setting is asked once at Stage (checkbox, default checked) and
  persisted to a new `project/meta.json` (`app/config.py`'s
  `read_project_meta`/`write_project_meta`), then used to debayer review
  thumbnails/lightbox previews (`app/imaging.py`'s `_debayer_block_mean` —
  averages each 2x2 Bayer tile into one RGB pixel using the FITS
  `BAYERPAT` header key, same "block-mean over a multiple-of-2 tile is a
  free rough debayer" trick already used in `framestats.py`); 7) clicking
  a review thumbnail's lightbox image now toggles a 2.2x zoom centered on
  the click point, panned via native scroll (`.lightbox-scroll`); 8) frame
  timestamps convert `DATE-OBS` (UTC, no trailing `Z`) to the browser's
  local time zone and show a date in mm/dd/yy alongside it
  (`formatCaptured()` — explicitly appends `Z` before parsing, since
  engines vary on how they treat a Z-less ISO datetime string); 9) the
  four per-night metric strips render as a 2x2 CSS grid with taller
  (72px) bars scaled to each metric's own **min..max** range (not
  0..max) plus axis labels showing the actual min/max — makes small
  real differences (e.g. FWHM 4.62 vs 4.69) visible as bars, distinct
  from flagging itself; 10) the anomaly z-score threshold (previously
  hardcoded at 3.0) is now a request field
  (`AnalyzeLightsRequest.anomaly_sigma`, still defaulting to 3.0) with a
  matching UI input, addressing Chris's "is 4.69 really that much worse
  than 4.62" question — the fix was making sensitivity tunable, not
  guessing a better constant; 11) excluding a frame no longer loses your
  scroll position — `window.scrollY` is captured before
  `renderAnalyzeOutput()` rebuilds the grid and restored after, since
  destroying/rebuilding that whole subtree was resetting it; 12) an
  "✓ Accept recommended exclusions" button unions every currently-flagged
  frame into the exclude set in one click; 13) a "⟲ Start over" button
  (behind a native `confirm()`) clears exclusions and this session's
  analysis results entirely; 14) Stack's per-night checkbox counts now
  show surviving (post-exclusion) frame counts, not raw light counts
  (`survivorCountForNight()`); 15) night checkboxes everywhere (Masters/
  Review/Stack) show whatever the source capture folder was actually
  called (e.g. "Night 1"), not the internal `night1` name — captured at
  staging time into `meta.json`'s `night_labels` (`app/staging.py`) and
  returned as each night's `label` field by `/status`
  (`nightDisplayLabel()` falls back to the internal name for projects
  staged before this existed); 16) Stack's master dark/flat overrides are
  now read-only fields filled via a new project-scoped file picker
  (`GET /projects/{name}/browse`, distinct from `/captures/browse` —
  browses this project's own `process/` tree and returns `.fit` files'
  absolute paths directly, since that's what `StackLightsRequest` expects)
  instead of freehand absolute-path text entry; 17) the progress line
  under each percent bar wraps instead of being clipped (`.progress-label
  .msg` now wraps; the old hard `.slice(0, 90)` truncation in `app.js` is
  gone too); 18) switching stretch mode on the final stack preview no
  longer collapses the frame and yanks the page up — `.preview-frame` now
  reserves a 3:2 aspect-ratio via CSS, and `showStackPreview()` only
  rebuilds the controls+`<img>` once per result path, updating just the
  existing `<img>`'s `src` on a stretch-mode change rather than tearing
  down and rebuilding the whole block. Also fixed one bug surfaced by
  this pass: the preview's "only rebuild when the path changes"
  optimization keyed off the *relative* result path alone, which could
  coincidentally collide between two different projects — a project
  switch now explicitly resets it. Verified end-to-end via the same
  headless-Chrome CDP approach against `multi1`'s real two-night data.
- ✅ **Frontend redesigned per Chris's 19-item live-usage feedback and
  re-validated end-to-end (2026-09-2x)**, superseding the first-version
  frontend described below — chronologically the FIRST of these
  redesign/polish rounds (the "second round," directly above, followed
  it). Chris used the first version, listed 19 specific issues in one
  message, and all 19 were addressed in this pass:
  1) new indigo/blue/amber/green/red palette (no longer visually an
  astrolab reskin — kept its dark theme); 2) a clickable step-wizard
  (`#stepper` in `index.html`, driven by `renderStepper()`/`stepStatus()`
  in `app.js`) showing Stage/Masters/Review/Stack, with only the active
  step's panel visible, checkmarks on completed steps, and disabled
  (unclickable) steps whose prerequisites aren't met yet; 3) an ellipsis
  (`…`) folder-browse button on the biases/darks dir fields, reusing the
  same picker built for staging's night rows; 4) sessions are auto-
  numbered ("Session 1", "Session 2", ...) with no name field exposed —
  internally still staged as `night1`/`night2`; 5) the stage result
  renders as a clean checkmarked list (`.stage-summary`), not raw JSON;
  6) masters' status/log display kept as-is (Chris confirmed it was
  already right); 7) "Preview script" is now a single arrow-toggle button
  (▾/▴) that shows/hides the script inline, replacing the old separate
  show/hide links; 8) a green `.complete-banner`/red `.error-banner`
  makes step completion or failure unambiguous everywhere a job finishes;
  9) clicking a review thumbnail opens a full-size lightbox
  (`#lightbox` overlay); 10) frame cards show `DATE-OBS` (via
  `framestats.py`'s new `captured_at` field) and the backend now sorts
  each night's frames chronologically before returning them, since bad
  frames cluster in time (clouds, dusk/dawn); 11) flagged vs. clean is
  now unambiguous green/red (frame-card left border, metric bars, badge)
  instead of the old teal/orange; 12) a "↻ Re-analyze survivors" button
  re-runs `/lights/analyze/run` with the current exclusions already
  applied; 13) FWHM and eccentricity (`roundness`) are now shown per
  frame alongside star count and SNR; 14) a `.help-box` explains bin
  factor (with an explicit warning about the precision/speed tradeoff)
  and threshold sigma; 15) an "Accept exclusions — show survivors only"
  toggle filters the review grid down to what will actually reach Stack;
  16) nights over 20 frames collapse to flagged frames ± 2 chronological
  neighbors, with the hidden runs shown as a clickable "⋯ N more" tile
  that expands in place (`computeVisibleItems()` in `app.js`) — logic
  reviewed carefully but **not exercised against real data**, since no
  test project currently has a night that large; 17) the Stack section
  shows a live pipeline diagram (`#stack-pipeline`, driven by the job's
  new `steps`/`current_step_index` fields — see `app/jobs.py`) alongside
  the percent bar; 18) a none/linked/unlinked stretch-mode toggle on the
  final stack preview (`app/imaging.py`'s `render_preview_png(...,
  stretch=...)`, backed by `AsinhStretch`+`PercentileInterval`); 19) a
  working download button (`GET /projects/{name}/download`) for the
  full-resolution `.fit`, verified to return the correct
  `content-disposition`/`content-length` and actual file bytes. All of
  this (except item 16, per above) was driven through a real, scripted
  headless-Chrome session against `multi1`'s real two-night data and a
  disposable clone project (`uitest`, since deleted) — including running
  a real ~185s two-night stack to completion and confirming the download
  actually serves the resulting 313MB `result.fit`. This session's
  testing also found and fixed a real bug — see Frontend/web gotcha #4
  (concurrent-run race) — and ruled out a false alarm — gotcha #5
  (HEAD requests 404 globally in this environment; irrelevant to real
  browser downloads, which use GET).
- ✅ **First-version frontend built and validated end-to-end against real
  data (2026-09-2x)**: `app/static/` (`index.html`/`app.js`/`styles.css`),
  served by FastAPI. Covers the full flow — stage (with a `/captures`
  folder picker), build masters, review lights (per-frame thumbnails,
  metric bars, anomaly flags, exclude checkboxes), and stack (picks up
  the review's exclusions, shows the final `result.fit`) — against
  `multi1`'s real two-night data. New backend support behind it:
  `GET /projects` (list), `GET /projects/{name}/status` (what's staged/
  built/run, read from the filesystem, not tracked state), `GET
  /captures/browse` (read-only folder picker), and `GET
  /projects/{name}/preview` (`app/imaging.py`: FITS -> stretched PNG
  quick-look, for both raw lights and finished stacks). Tested with a
  scripted headless-Chrome session (Chrome DevTools Protocol, no
  Puppeteer needed) driving real clicks through stage/analyze/exclude/
  stack-preview, not just eyeballing a static screenshot — this is what
  caught both bugs in the Frontend/web gotchas section above before
  Chris ever saw them. Styling follows astrolab's dark card-based look;
  functionality follows Siril's own OSC Multi-Night Stacking tool
  (per Chris) rather than astrolab's much larger pipeline. Superseded by
  the redesign above — kept here for the backend endpoints it introduced,
  which are still current.
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
- ✅ **Multi-night stacking validated end-to-end against real two-night
  data (2026-09-20)**: Chris added real "Night 1"/"Night 2" test captures
  (Elephant Trunk Nebula) to `/captures` — shared `biases`/`darks` at the
  top level, per-night `lights`/`flats` each. Staged via the new
  `/projects/{name}/stage` endpoint, built shared master bias/dark + one
  master flat per night via `/masters/run` with `nights=[...]`, then ran
  `/stack/run` with the same `nights` — `merge` (never previously
  executed, only render-tested) combined both nights' 10-frame `pp_light`
  sequences into a 20-frame `all_lights`, registered, and stacked
  correctly into a real, correctly-sized `result.fit`. This is now proven
  working, not just structurally plausible.
- ✅ **Per-night master flats + shared master bias/dark implemented**:
  `BuildMastersRequest`/`render_build_masters` now take the same `nights`
  list as stacking — bias/dark always build once at `process/master_{bias,
  dark}.fit`; each named night gets its own `process/nights/<name>/
  master_flat.fit`, calibrated against the shared master bias. Matches
  Chris's real workflow ("usually a single set of bias and dark... for
  each night, a unique set of lights and their matching flats").
- ✅ **`POST /projects/{name}/stage` replaces manual `mkdir` +
  `scripts/stage_captures.sh`** (`app/staging.py`): symlinks
  biases/darks/per-night lights+flats from `CAPTURES_DIR` into a
  project's `raw/` tree in one call, validated against the real
  multi-night captures folder above. Source folder names (e.g. the literal
  "Night 1", with a space) never need to match any convention — the
  caller picks the internal name (`NightSource.name`) that actually lands
  on disk, per Chris's flexibility requirement. Rejects path traversal
  (absolute paths, `..`) since these are strings straight off an HTTP
  request body — see `_resolve_capture_dir()`'s docstring for the
  `Path("/a") / "/b"` gotcha this guards against.
- ✅ **`/jobs/{id}` now exposes `percent_complete` and `current_command`**,
  parsed from siril-cli's own `progress: N%` and `Running command: X` log
  lines (`app/jobs.py`). Closes the "aware of steps/percentages" half of
  the Endstate's process-visibility ask; a real wall-clock ETA is still
  nobody's job (would need per-step historical timing, not attempted).
- ✅ **Frame review implemented: `/projects/{name}/lights/analyze`**
  (render + run). First version (2026-09-20) calibrated+registered each
  night's lights via Siril, no stacking/merge, harvesting per-frame stats
  from the resulting `.seq` file. **Replaced entirely (2026-09-2x)** by a
  pure Python astropy+photutils implementation (`app/framestats.py`) after
  gotcha #8's session-degradation cliff turned up while validating it —
  see the architecture decision above. The Siril-based version and
  `app/seqstats.py` are gone, not kept as a fallback. Current version:
  operates directly on RAW, uncalibrated lights (no masters needed, Siril
  never invoked), block-mean bins 4x before detection (~11x faster,
  benchmarked against real capture data — also acts as a free rough
  debayer for OSC/Bayer sensors since a bin factor that's a multiple of 2
  averages across a full RGGB tile), and uses `IRAFStarFinder` for
  FWHM+roundness+star-count in one pass plus `sigma_clipped_stats` for
  background. Real result against `multi1`'s two-night data: **7.9s total
  for 20 frames**, vs the old Siril path's ~104s for the same data (and
  that 104s was itself inflated by gotcha #8 — a clean run would've been
  faster, still nowhere near this). **Recommends, never auto-filters**,
  per Chris's explicit direction — nothing is excluded unless a human
  passes `exclude_frames`, which is now just a plain filename filter
  in Python (no symlink staging needed — that machinery was only ever
  needed because Siril's `convert` operates on a whole directory).
  astropup-blink itself wasn't actually inspectable when researched (see
  Reference material) — this was designed from photutils' capabilities
  plus Chris's stated requirement, not from a real look at that app's UI.
  **Numbers are not comparable to the old Siril-based ones** — different
  tool, different convention (photutils' `roundness`: 0=round, higher=
  more elongated; Siril's was the reverse, 1.0=round) — if either gets
  looked at again, don't assume continuity with earlier analyze results.
- ✅ **Fixed a real staleness bug in the Siril-based pipeline** (gotcha
  #6, found while validating the *original* Siril-based analyze before it
  was replaced): light conversion/registration/stacking happens in a
  disposable per-run workspace, wiped clean before every run
  (`prepare_fresh_dirs()`), separate from wherever that scope's master
  files live. Still relevant to **`/stack/run`**, which still uses Siril;
  moot for `/lights/analyze` now that it doesn't touch Siril at all.
- ✅ **Collapsed the single-night/multi-night layout duality (2026-09-20,
  same day as the above)**: Chris hit the dual-layout bug directly —
  `multi1` only ever had `raw/nights/...`, and an analyze call with no
  `nights` specified silently assumed the *other* (flat `raw/lights`)
  layout and failed confusingly. `nights` is now required and non-empty
  everywhere (`BuildMastersRequest`, `LightsSelectionRequest`) — a missing
  one is a clean 422 from FastAPI, not a guess. Every project always uses
  `raw/nights/<name>/...`; a "single-night" project is just one with a
  single entry in `nights`. Also surfaced gotcha #7 in the process
  (`merge` refuses fewer than two inputs) while checking whether the
  register/stack branching could collapse too — it can't, that's the one
  place night-count still matters. Re-validated end-to-end after the
  change: single-night direct path (no merge) and the two-night merge
  path both re-run successfully against `multi1`'s real data.
- ✅ **`/masters/run` gotcha #6 fix implemented and verified
  (2026-09-2x)**: bias/dark/each night's flat each build in their own
  `process/_build/...` scratch dir, wiped fresh every run — see gotcha
  #6's updated note. Verified by rebuilding masters twice in a row
  against `multi1`'s real (now 2-night, 28-light) data; both runs
  succeeded identically, no stale-file bleed-through.
- ✅ **`/stack/run` and `/masters/run` gotcha #8 fix implemented
  (2026-09-2x)**: every night's calibrate step (and every master type)
  now runs as its own independent `siril-cli` subprocess instead of one
  script covering everything — see the architecture decision above,
  gotcha #8's updated note, and `jobs.create_multi_script_job()`.
  Re-validated end-to-end against `multi1`'s real 2-night, 28-light data
  after the change: masters build (4 independent subprocesses: bias,
  dark, flat×2) and the full multi-night stack (2 calibrate subprocesses
  + 1 merge/register/stack subprocess) both re-ran successfully.
- ✅ **Anomaly-based frame flagging implemented and validated against
  real known-bad data (2026-09-2x)**: `app/framestats.py`'s
  `flag_anomalies()` adds a robust (MAD-based) per-metric z-score
  (`star_count`, `fwhm`, `roundness`, and a new `snr` field — median
  detected-star flux / background std, added to match astropup-blink's
  own SNR panel) computed against the rest of each night's own frames,
  flagging anything at z >= 3.0 on any metric. Chris sent a real
  astropup-blink screenshot of Night 2 (17 subs, 10 kept / 7 flagged) and
  identified real problem frames by eye: night1's frame 0001 (elevated
  background, reduced star count — a subtler "still settling after dusk"
  case) and night2's frames 0105-0111 (a textbook dawn-twilight ramp:
  background 635->8756 ADU, star count 368->18, monotonic). Result:
  correctly flagged 0001 (plus, honestly, two milder frames right after
  it showing the same "still settling" pattern at a smaller scale — z
  ~4.3-4.5, a real signal, not noise) and 6 of the 7 twilight frames
  outright (0106-0111; 0105 itself sits at z~2.7-2.9, just under the 3.0
  threshold — visible as the start of a clear ramp in the raw z-scores
  even though it doesn't cross the flag line on its own). Nothing here
  was tuned to hit these exact frames — defaults were set once, from a
  single quick pass, before this validation ran.
- ✅ **Master reuse policy clarified in `StackLightsRequest`'s docstring**
  (2026-09-2x, no behavior change — this already matched Chris's
  intent): master bias/dark are shared project-wide; master flat is
  per-night by default, with `master_flat` as an override for the
  exception (a night missing its own flats), not a way to force one
  shared flat across nights. A true *per-night* override (vs. today's
  single value applied to every night if given) is still not wired up —
  see Immediate next steps.
- ✅ **Active-job click-through bug fixed and verified (2026-09-21)** —
  Chris: "when I click on an active job, it always drops at file staging
  rather than whatever the actual active stage in that project is." Root
  cause: the active-job-row's `onclick` dispatched a synthetic `change`
  event on `#project-select`, and that handler unconditionally reset
  `state.activeStep` to `"stage"` regardless of why the switch happened.
  Fixed by extracting the handler into a named `switchToProject(name,
  initialStep)` (`app.js`) that takes the target step as a parameter —
  the dropdown's own `change` listener still passes `"stage"`, but
  `renderActiveJobsPanel()`'s row click now passes `stepForJobKind(job.
  kind)` (`"masters"→"masters"`, `"stack"→"stack"`, `"analyze"→"review"`,
  default `"stage"`). Clicking a row for the *current* project now just
  flips `state.activeStep` and re-renders instead of running the whole
  project-switch reset for no reason. Verified end-to-end via curl +
  headless Chrome: started a real stack job on `live-test-3`, loaded the
  frontend with no project selected, clicked its active-job row, and
  confirmed both the project selector and the visible step panel landed
  on `stack` (not `stage`) — for both the cross-project case and the
  already-on-that-project case.
- ✅ **Full code review pass (2026-09-21)**, requested after the above
  fix: removed `jobs.create_job()` (the single-script job runner) —
  confirmed zero call sites since `create_multi_script_job()` fully
  replaced it; removed `scripts/stage_captures.sh` — confirmed unused by
  any runtime code path (`app/staging.py` replaced it earlier this
  session) and, worse, stale: it assumed a flat `lights/darks/flats/
  biases` layout under `CAPTURES_DIR` that predates the current
  `raw/nights/<name>/...` model, so running it today would've built a
  broken project. Updated the handful of docstring references to both
  (`app/config.py`, `app/main.py`, `app/models.py`, `app/staging.py`).
  Removed four dead CSS classes with zero references in `index.html`/
  `app.js` (`.complete-banner`, `.log-toggle-btn`, `.section-title`,
  `.two-col`). Removed an unused `field` import in `app/ssf.py`. No
  other dead code, TODOs, or stray debug output found (checked via AST
  import/def-usage analysis across `app/*.py` and a grep sweep for
  unused JS functions and CSS classes) — the codebase came out of this
  round clean.
- ✅ **README.md rewritten (2026-09-21)** with a real description of what
  the tool does, the four-step workflow, and the tech stack — previously
  a single placeholder sentence.
- ✅ **Production Dockerfile added (2026-09-21)** as prep for moving off
  the dev container per Chris's request ("the next step... is to move
  this out of dev and into a fully deployable container... if you have
  to do any prep before that, get that done"). New `Dockerfile` (next to
  the existing `Dockerfile.dev`) copies `app/`/`static/`/`templates/`
  into the image at build time instead of bind-mounting, and runs
  `uvicorn` directly with no `--reload` — a rebuild is required to pick
  up code changes, which is the intended tradeoff for something meant to
  run unattended rather than be iterated on live. Also added `numpy` to
  `requirements.txt` as an explicit pin (`app/imaging.py` and `app/
  framestats.py` both `import numpy` directly; it was only ever present
  as an unpinned transitive dependency of `astropy`/`photutils`, which
  works today but isn't something to rely on for a production image).
  Built and smoke-tested for real: `docker build` against the actual
  repo succeeded, and a container run from that image (real `/data` and
  `/captures` mounts, no port published) answered `/health`, `/projects`,
  and served the frontend correctly — then torn down, nothing left
  running. Actually packaging/publishing this on UnRAID is explicitly
  the next round, not done here.
- ✅ **GitHub Actions CI + UnRAID deployment complete (2026-09-2x)**:
  `.github/workflows/docker-publish.yml` builds and pushes to
  `ghcr.io/cfmorrell/astro-stacker` on every push to main; Chris set the
  repo's Actions permissions to read/write and flipped the package to
  public, then deployed the container on UnRAID — confirmed up and
  running. The dev container (`astro-stacker-dev`) stays running
  independently for ongoing development; the two are separate containers
  now, not one replacing the other.
- ✅ **Seven feature requests from real usage, implemented and verified
  end-to-end against a real, reorganized test dataset (2026-09-22)**.
  Chris restructured his test captures to mirror his actual astrophoto
  library layout — `<Target>/<date>-<target>-<camera>-<scope>/{lights,flats}`
  (optionally with `Night 1`/`Night 2` subfolders for multi-night
  targets) for light targets, plus a separate shared
  `000-CalibrationFrames/{Bias,Dark}/<camera>/<exposure-or-date>/` tree —
  with deliberately few frames per target to keep test stacks fast. All
  seven were verified against this real layout (curl for the backend,
  headless Chrome + CDP for the frontend), not just code review:
  1. **Output filename = project name + total integration time.**
     `app/ssf.py`'s new `output_basename()` sums each actually-included
     light frame's exposure (parsed from its filename via the new
     `app/frameinfo.py`, post-exclusion — computed from the RAW night
     dirs before `_resolve_nights()` swaps in the excluded/selected dir,
     since that one isn't populated on disk until later) and formats it
     as e.g. `ElephantTrunkNebula-IC1396_5h24m` (or `_55m` under an hour,
     `_2h` for an exact-hour total with no leftover minutes) — Chris's
     own follow-up correction from an initial `5.4h`-style decimal format
     that shipped first. `_format_integration()` rounds to whole minutes
     BEFORE splitting into h/m specifically to dodge a 59.6-minute-style
     rounding-carry bug. Falls back to just the project name if no
     frame's exposure could be parsed. The `-out=` target in both
     `register_stack_*.ssf.j2` templates is now this computed name, not
     a hardcoded `result`. Since the filename is now dynamic, `/status`
     can no longer assume `result.fit` — `run_stack()` records the
     actual filename into project meta
     (`night_result_filenames`/`merged_result_filename`) right before
     the job starts, and `app/status.py` reads it from there (falling
     back to `result.fit` for any project stacked before this existed).
     Verified for real: a 15-light, 300s-exposure single night produced
     `heart-test_1h15m.fit` on disk, and `/status` correctly reported
     and previewed it at that exact path; a real 2-night, 28-light merge
     produced `live-test-3_2h20m`.
  2. **Stacking methods narrowed to Rejection (Sigma) / Winsorized Sigma
     / Mean, sigma fields hidden for Mean.** Confirmed via `siril-cli`'s
     own `help stack` (1.4.3) that Siril's real model is: one stack type
     (`rej`/`mean` — literally the same keyword) plus a separate
     REJECTION TYPE argument (`sigma`, `winsorized`, `none`,
     `percentile`, `median`, `linear`, `generalized`, `mad`), and that
     Winsorized is Siril's own default when no type is given — meaning
     the old UI's plain `rej 3 3` (no explicit type) was **already**
     running Winsorized under the hood the whole time. `StackMethod`
     (`app/models.py`) is now exactly `sigma`/`winsorized`/`none`
     (`none` = `rej none`, a plain mean with no clipping at all — sigma
     values are meaningless for it and Siril's CLI doesn't even accept
     them for `none`). Frontend hides the sigma low/high fields via a
     `change` listener on the method `<select>` whenever `Mean` is
     selected, for both the Masters and Stack sections (same enum backs
     both). Winsorized Sigma is now the default, matching Siril's own
     prior default behavior exactly — no behavior change for anyone who
     never touched this dropdown.
  3. **Root working directory per project.** `StageProjectRequest`
     gained `root_dir` (relative to `CAPTURES_DIR`, validated the same
     way as `biases_dir`/`darks_dir`), stored in project meta and
     exposed via `/status`. Every Stage-step folder picker
     (`attachFolderBrowser` in `app.js`) now starts browsing from a
     project's `root_dir` instead of the full captures root whenever its
     own field is still empty — a starting point only, never a
     restriction, since the breadcrumb still reaches anywhere else under
     captures. **Known tradeoff, not a bug**: since biases/darks live in
     a completely separate shared tree
     (`000-CalibrationFrames/...`) from a target's own root, picking
     them still means backing out via the breadcrumb once first — root_dir
     helps lights/flats (the deeply-nested, per-project-specific fields)
     far more than it helps calibration frames. Flagged to Chris; not
     changed without his say-so, since a separate "calibration frames
     root" is a bigger, separate feature if he wants it.
  4. **Drizzle**, adjustable scale/pixel-fraction/kernel. New
     `DrizzleOptions` (`app/models.py`) maps directly to `register`'s own
     `-drizzle -scale= -pixfrac= -kernel=` options (confirmed via
     `siril-cli`'s `help register`). Critical interaction, also
     confirmed from that same help text: *"when using -drizzle on images
     taken with a color camera, the input images must not be
     debayered"* — `render_stack_lights()` now drops calibrate's
     `-debayer` flag (keeping `-cfa`/`-equalize_cfa`, which are
     unrelated to demosaicing) whenever drizzle is enabled on an OSC
     project. Verified for real, not just script-text review: ran an
     actual drizzle stack (scale 1.0, pixfrac 0.9, square kernel)
     against real HeartNebula OSC data end-to-end — calibrate, register
     with drizzle, and stack all completed successfully producing a
     correctly-named, full-color result.
  5. **Header "astro-stacker" text is now a link** back to no-project-
     selected with Stage as the step that'll show once a project is
     picked (`switchToProject(null, "stage")`).
  6. **Project row simplified to just a dropdown + "+ New project"
     button.** Clicking it prompts for a name (native `prompt()`, same
     pattern as the existing delete-confirmation), then opens a one-off
     folder-picker (`pickCapturesFolder()` in `app.js`, sharing
     `/captures/browse` + the breadcrumb UI with `attachFolderBrowser`
     but resolving a promise instead of writing into a persistent input)
     to choose the new project's `root_dir` — skippable, in which case
     pickers just fall back to the full captures root as before. This
     also made project creation eager rather than lazy: it now calls
     `POST /stage` immediately (creating the project directory + meta
     right away) instead of only existing once "Stage files" is first
     clicked, since `root_dir` needs somewhere to be recorded
     immediately.
  7. **Darks-vs-lights exposure mismatch warning.** New
     `app/frameinfo.py` (factored out of what used to be
     `main.py`'s `_detect_frame_type`, now shared) adds
     `detect_exposure_seconds()`, parsing each filename's `_<number>
     <s|ms>_` pattern (e.g. `_300.0s_`, `_1.0ms_`) the same way frame
     type is already detected, with the same "≥90% agreement or don't
     claim to know" rule. `/captures/browse` now also returns
     `detected_exposure_s`. The frontend remembers the darks folder's
     detected exposure (module-level, since darks are staged once per
     project) and checks it against each session's lights whenever
     either is (re)picked, via the same combined
     `.session-mismatch-warning` used for the existing lights/flats
     checks — not a hard block, same as those. Verified for real by
     deliberately staging the Bias folder (1ms) as "darks": both the
     existing type-mismatch warning ("looks like bias frames, not
     darks") and the new exposure warning ("These lights are 300s
     exposures, but the darks are 1ms") fired together, combined into
     one message.
- ✅ **Data-safety question answered + verified against Chris's real
  production data (2026-09-22)**: Chris asked whether pushing/deploying
  an update is safe for existing projects, and whether a migration plan
  is needed. Checked directly against his actual running containers
  (`docker inspect`) rather than assuming: the production container
  (`AstroStacker`, on `ghcr.io/cfmorrell/astro-stacker`) mounts
  `/mnt/user/docker_appdata/astrostacker/data` and
  `/mnt/user/Astronomy` (his whole library), while the dev container
  (`astro-stacker-dev`) mounts the completely different
  `/mnt/user/docker_appdata/astro-stacker/data` (note the hyphen) and
  just the test subfolder — **no shared-volume collision risk between
  dev and prod**, confirmed, not assumed. Also inspected Chris's one
  real production project (`HeartNebula-2026-09-15`, already staged,
  masters built, and stacked to a plain `result.fit` under
  pre-this-session code) directly against everything built this
  session: its `meta.json` has neither `root_dir` nor
  `night_result_filenames`/`night_dark_overrides`/etc., and every read
  of those fields anywhere in the codebase goes through `.get(key,
  default)` (verified by grepping for any *direct* `meta[...]` read,
  finding only writes) — so `/status` on this real project still
  correctly reports its existing `result.fit` via the fallback default,
  `root_dir` just comes back `null` (pickers fall back to full captures
  root), and nothing crashes or silently misbehaves. **The actual
  answer, going forward**: this project's schema evolves by ADDING
  optional, defaulted meta fields, never by renaming/removing existing
  ones or requiring a field to exist — that discipline is what makes
  deploys safe without a migration step, and it should keep being
  followed rather than treated as a one-time fix. No forward-migration
  UI (prompt-to-repair or offer-to-delete) was built, since there's
  currently no real incompatibility for it to handle — revisit only if
  a future change actually needs to break this pattern.
- ✅ **Calibration frames now aligned per night from the Masters step,
  not overridden uniformly from Stack (2026-09-22)** — Chris: "let's get
  rid of the master overrides [from Stack] and move them back to
  calibration frames. That is the panel where we should be aligning
  calibration frames to nights... choose different darks for different
  nights... use a different night's flats on a particular night, not
  necessarily universally." The old Stack-step `master_dark`/
  `master_flat` fields on `StackLightsRequest` applied ONE override to
  EVERY selected night at once — the exact opposite of what's actually
  useful for the case Chris described (a project spanning months, where
  different nights genuinely need different calibration). Replaced with
  a new persistent per-project setting: `CalibrationOverridesRequest`
  (`app/models.py`) sets `night_dark_overrides`/`night_flat_overrides`
  (night name → absolute file path) via new `POST /projects/{name}/
  calibration-overrides`, stored in project meta (not on the stack
  request itself, since it's project configuration, not a one-off
  run-time parameter) and read back via `/status` (each night's
  `dark_override`/`flat_override`). `ssf.py`'s `_resolve_nights()` now
  resolves `dark_master` PER NIGHT (previously one shared value for
  every night in a request) from these overrides, falling back to the
  normal shared `process/master_dark` / that night's own
  `process/nights/<name>/master_flat`. Frontend: the Masters step (now
  genuinely "where calibration frames get aligned to nights," matching
  Chris's framing) gained a per-night table — dark/flat file pickers per
  staged night, reusing the existing project-file-browser component,
  auto-saving the complete current picture on every change (no separate
  save button). Verified for real against `live-test-3`: set a per-night
  dark override and confirmed only that night's calibrate step picked it
  up in the rendered script while the other night kept its own default;
  set and cleared a flat override the same way; confirmed via headless
  Chrome that picking a file through the UI actually persists
  server-side.
- ✅ **Drizzle promoted out of "advanced options" (2026-09-22)** — with
  the master overrides gone, Stack's advanced-options section would have
  held only drizzle, so the whole toggle was removed for Stack and
  drizzle now sits directly in the card body, always visible. (Review's
  own separate "advanced options" — star-detection threshold/bin factor
  — is untouched.)
- ✅ **User-facing text audit (2026-09-22)** — Chris: "double check all
  comments that are displayed on the page and ensure they are targeted
  at a user of the app, not the developer." Found and fixed two real
  leaks: the Review card's title named the actual Python libraries
  ("astropy + photutils, no Siril") instead of describing what the step
  does for the user; and a hint referenced "photutils' own conventions"
  by library name when explaining why roundness numbers don't match
  Siril's — reworded to compare against Siril directly (a comparison
  genuinely useful to Chris, who already knows Siril) without naming the
  library doing the computation. Also fixed a stale Stack card title
  that still said "into result.fit" even though the output filename is
  now dynamic (see the integration-time bullet above), and removed a
  leftover "See Handoff.md" from a hint that got deleted along with the
  old master-override fields anyway. Swept the rest of `index.html`'s
  labels/hints and `app.js`'s dynamically-generated user-facing strings
  (hints, warnings, alert/confirm/prompt text) for the same pattern —
  nothing else found. (Source-code `//` comments are a separate thing,
  deliberately left alone — those are for whoever maintains this code
  next, not something the running app ever shows anyone.)
- ✅ **Two small follow-up tweaks (2026-09-22)**: drizzle's default
  `scale` changed from `1.0` (no upscale) to `2.0` per Chris ("we don't
  want to start at 1") — `DrizzleOptions` in `app/models.py`, the
  `stack-drizzle-scale` input's default in `index.html`, and its JS
  parse-failure fallback all updated together so they can't drift out of
  sync. Stack's "Excluded frames" display now groups by night instead of
  one flat comma-joined list — `refreshExcludeDisplay()` (`app.js`)
  cross-references `state.excludeFrames` against
  `state.lastAnalyzeResult.nights` to find each excluded filename's
  night, falling back to the old flat list only if no analyze result is
  loaded at all (shouldn't normally happen, since exclusions only ever
  come from the Review step). Verified via headless Chrome.
- ✅ **Two small UI fixes (2026-09-22)**: Stage's "Biases dir"/"Darks dir"
  labels dropped "(relative to captures)" — an implementation detail the
  user doesn't need, not something that changes what they do. Stage's
  layout reordered: the lights/flats session builder now comes first,
  biases/darks moved below it (was the reverse).
- ✅ **Verified — and then genuinely fixed — that a project with zero
  calibration frames can stack successfully (2026-09-22)**. Chris asked
  directly: "have we tested a scenario where a user may have no
  calibration frames? Can we stack successfully if we skip past the
  calibration frame process entirely?" Tested it for real and found the
  answer was actually **no**: `_resolve_nights()` hard-required both a
  dark AND a flat master to exist for every night, raising a 400
  ("master dark not found...") the moment either was missing — even
  though bias was already fully optional (confirmed
  `render_build_masters()` already skips it cleanly when `raw/biases`
  doesn't exist) and even though Siril's own `calibrate` command treats
  `-bias=`/`-dark=`/`-flat=`/`-cc=` as ALL genuinely optional (confirmed
  via `help calibrate`). Fixed in `ssf.py`: `_resolve_master()` now
  distinguishes an EXPLICIT override that's missing (still a hard
  error — that's a real mistake) from a DEFAULT that's simply not built
  (now resolves to `None`, meaning "skip this calibration step for this
  night" instead of failing); `calibrate_night.ssf.j2`'s `-dark=`/
  `-flat=` and `render_stack_lights()`'s `-cc=dark` (which needs a dark
  master to reference and makes no sense without one) are now all
  conditional on the corresponding master actually existing. Verified
  for real, not just rendered-script review: ran an actual stack job
  with flats but no bias/dark at all (succeeded), and a second one with
  **zero** calibration frames of any kind — no bias, no dark, no flat
  master — which also completed successfully end to end and produced a
  real, correctly-named result file.
- ✅ **Narrowband/mono workflow explored against Chris's new real test
  data and the missing piece (per-folder filter selection) built
  end-to-end (2026-09-22)**. Chris added a real mono (ZWO 2600MM, not
  MC) narrowband session — `HeartNebula-IC1805/2025-10-04-HeartNebula-
  2600MM-WO61/{Light,Flat}` — with H/O/S filters all mixed together in
  ONE Light folder and ONE Flat folder (30 files each, 10 per filter);
  deliberately no matching 2600MM calibration frames exist at all
  (only 2600MC ones do), making this dataset exercise the
  zero-calibration-frames fix above too. Filename convention here
  differs structurally from the OSC test data (no `<angle>deg` field,
  but an added filter code right before `_gain<N>_`, e.g.
  `..._2600MM_H_gain100_...`) — confirmed the existing exposure/type
  detectors keep working unmodified against it (they search for
  specific substrings, not a fixed overall structure), and Review's
  astropy/photutils analysis runs cleanly on genuinely single-channel
  mono FITS data with no changes needed there either.
  **What was actually missing**, exactly as Chris predicted ("I think
  top of mind is... some way of filtering by filter inside of a
  folder"): staging had no concept of "filter" at all — picking a mixed
  folder as `lights_dir`/`flats_dir` would symlink all 30 files
  regardless of filter into one "night," which is meaningless (H/O/S
  each need their own master flat and their own independent
  calibrate/stack pass — they only get combined later, in other
  software, as a narrowband-to-RGB palette). Built:
  - `app/frameinfo.py` gained `parse_filter()`/`detect_filters()` — the
    filter code sits right before `_gain<N>_` in this convention
    (`_([A-Za-z]{1,6})_gain\d+_`); an OSC filename has nothing there at
    all (camera model sits directly against `_gain`), so this correctly
    returns nothing for OSC data rather than a false match. Confirmed
    against real filenames from both datasets before writing the regex,
    not just assumed.
  - `/captures/browse` now also returns `detected_filters` (e.g.
    `["H","O","S"]`, empty for OSC).
  - `NightSource` (the per-session staging request) gained an optional
    `filter` field. `staging._link_dir()` now filters by it when
    staging BOTH lights and flats for that session (one filter applies
    to both, since a session's flats only make sense matched to that
    same session's filter) — and now also wipes stale FITS symlinks
    from the destination before relinking (previously only added/
    overwrote), needed so re-staging a night with a DIFFERENT filter
    can't leave the previous filter's files mixed in. An explicit
    filter that matches zero files is a hard 400, not a silently-empty
    night. The night's display label gets the filter appended (e.g.
    "2025-10-04-HeartNebula-2600MM-WO61 (S)") so same-folder,
    different-filter sessions are distinguishable in every checklist.
  - Frontend (Stage): picking a lights or flats folder that resolves to
    exactly one filter applies it automatically, no extra click; a
    folder mixing 2+ filters shows a required "Filter" dropdown for
    that session (populated from `detected_filters`), and "Stage files"
    is blocked with a clear alert if it's left unset. Fixed a real bug
    caught during testing: picking flats (also ambiguous) after already
    choosing a filter for lights was resetting the choice back to
    unset — now preserves the current selection across both pickers as
    long as it's still valid for the newly-detected set.
  - **Also caught and fixed a related, previously-invisible gap**: with
    filter-tagged nights now possible, nothing stopped selecting two
    DIFFERENT-filter nights together in Stack's "nights to stack"
    checklist, which would silently `merge` two different wavelengths
    into one nonsensical stack — verified this was a real, live gap by
    actually rendering the script for an O+S selection and watching it
    produce a `merge "...O.../pp_light" "...S.../pp_light"` line with
    no warning at all. Fixed: each night's `filter` is now tracked in
    project meta and exposed via `/status`; a new
    `checkStackFilterMismatch()` (matching this app's established
    warn-don't-block pattern — same as the lights/flats and exposure
    mismatch warnings) shows an inline warning under "Nights to stack"
    whenever the currently-checked nights span more than one distinct
    filter.
  - **Real, incidental discovery, not an app bug — since fixed by
    Chris**: one flat frame in the test data
    (`Flat_..._2600MM_H_..._0008.fit`) was genuinely truncated (~50.3MB
    vs. the uniform ~52.2MB every sibling flat is), which crashed
    Siril's own preprocessing for the H filter's flat build specifically
    (`Fitsio error reading data... Could not load image 7 from
    sequence`) — confirmed via file size comparison across all 30
    flats, isolated to exactly that one file; O and S built and stacked
    cleanly the whole time. Chris replaced the file (2026-09-22);
    re-verified end to end afterward — H's master flat build and full
    stack both now succeed too, all three filters confirmed working.
- ✅ **Calibration-frame preview stretch fixed (2026-09-22)** — Chris:
  "the preview is showing extremely strong dust motes, but not much from
  the vignetting... exceptionally blown out." Root-caused on real data
  before touching any code: pulled a real master flat's actual pixel
  stats and found the true vignetting signal is only a ~5-10% brightness
  falloff center-to-corner, while dust motes are sharp outlier pixels
  covering under ~0.5% of the frame — `PercentileInterval(99.5) +
  AsinhStretch(0.1)` (the existing "unlinked" mode, tuned for the
  OPPOSITE problem: huge-dynamic-range light frames with faint
  nebulosity against near-black sky) clips its black point right at the
  motes' dark cores, crushing the entire smooth vignetting gradient
  toward white while making the motes look extreme by comparison —
  confirmed by rendering the same frame multiple ways and comparing
  actual output histograms, not just eyeballing it. New `"calibration"`
  stretch mode (`app/imaging.py`): per-channel `ZScaleInterval` (the
  same robust-to-outliers algorithm DS9/IRAF use), no curve at all —
  visibly fixed on the real flat (vignetting now clearly visible, motes
  proportionate) before it was wired in. `renderMastersPreviews()`
  (`app.js`) now requests `stretch=calibration` instead of `unlinked`
  for master bias/dark/flat thumbnails specifically; raw light frame
  previews (Review) and the final stack preview are untouched — they
  still want the strong asinh stretch, which is right for THAT content.
  Also fixed a real bug caught while making this change: the per-channel
  dispatch in `render_preview_png()` hardcoded `"linked"` for EVERY
  per-channel call regardless of the actual requested mode — harmless
  before (since "linked" and "unlinked" happen to compute identically
  for a single channel), but would have silently discarded the new
  "calibration" mode's whole point if left as-is.
- ✅ **Real cross-project state-leak bug found and fixed (2026-09-22)** —
  Chris: "I was just running an OSC test, and while it was stacking
  built a mono test. The OSC test finished, but when I clicked into
  stack on the mono test, the calibrate/register/stack status markers
  were already green." Root cause: this app has ONE shared set of DOM
  elements for Stage/Masters/Review/Stack, repainted for whichever
  project `switchToProject()` last opened — not one DOM tree per
  project (deliberate, simple-SPA design). `pollJob()` (the loop started
  by clicking Masters/Analyze/Stack's own Run button, distinct from the
  ALREADY-correct global active-jobs panel) had no idea the user could
  navigate to a completely different project while it kept running in
  the background: it wrote into `#stack-pipeline`/`#stack-progress`/log
  views and fired its `onDone` callback (which touches `state.status`,
  `state.lastAnalyzeResult`, etc.) unconditionally, every tick, forever
  — so a still-running OSC job's pipeline markers ended up painted
  directly onto whatever OTHER project's Stack panel the user had since
  opened. Two-part fix: (1) `pollJob()` now takes an `ownerProject`
  (the project captured at the moment the job was started) and only
  touches shared DOM / fires `onDone` while `state.project` still
  matches it — going quiet rather than stopping outright, so it
  correctly resumes updating if the user switches back before the job
  finishes; (2) `switchToProject()` now explicitly resets
  `#stack-pipeline`/`#stack-progress`/`#masters-progress`/
  `#analyze-progress`/every `[data-log-view]` panel on every switch,
  since part (1) alone only stops FUTURE contamination — DOM already
  painted by another project's job before the user switched away needed
  an explicit clear, not just a guard against further writes. Also
  fixed the same underlying class of bug in `wireToggleButton()`
  ("Preview script"): it cached its rendered output after the first
  fetch and never re-fetched, so reopening the SAME panel after
  switching projects would keep showing the FIRST project's script
  forever — removed the caching entirely (a script-preview render is
  cheap; there was no real reason to cache it across projects in the
  first place). Verified for real via headless Chrome: started an
  actual stack job on one project, switched to a completely different
  one mid-run, confirmed the pipeline/progress areas were fully hidden
  and empty immediately on switch AND stayed that way even after
  waiting well past when the background job would have finished.
- ✅ **Mono/narrowband output filenames now include the filter
  (2026-09-22)** — Chris: "we also need to indicate the filter in the
  final filename so that we can combine it appropriately in the
  future." `output_basename()` (`app/ssf.py`) now takes the set of
  filters actually present among the stack's included nights (read from
  the same `night_filters` project-meta that backs the Stage-time
  filter picker and the Stack-panel mismatch warning) and inserts them
  between the project name and integration time — e.g.
  `HeartNebula-IC1805_H_1h15m.fit` for a single-filter narrowband stack,
  vs. `ElephantTrunkNebula-IC1396_5h24m.fit` for OSC data (no filter
  segment at all, unchanged). If a stack somehow includes more than one
  distinct filter — only possible by overriding the Stack panel's own
  mismatch warning — they're joined with "+" rather than silently
  picking one. Verified for real against a staged S-filter session.
- ✅ **Camera + date sanity checks on calibration frames, from real FITS
  headers (2026-09-23)**. Chris asked two things: whether FITS headers
  carry enough info to confirm calibration frames match the lights'
  camera, and (assuming yes) to warn if flats aren't within a day of the
  lights' session, or darks/bias are more than a year older or a month
  newer. **Answer, confirmed by actually reading real headers from both
  test cameras, not assumed**: yes — `INSTRUME` reliably distinguishes
  camera MODEL (`'ZWO ASI2600MC Duo'` vs `'ZWO ASI2600MM Pro'` in this
  dataset) and is present on every frame type. Caveat worth remembering:
  there's no serial number field in these headers at all, so this can't
  tell apart two physical units of the *same* model if Chris ever owns
  two; and `EGAIN`/pixel size/resolution are identical across both
  cameras here (same sensor family), so they're not useful as a
  secondary signal either — `INSTRUME` is the only reliable camera-
  identity field available. `DATE-OBS` (present on every frame) backs
  the date checks directly.
  New `app/fitsinfo.py` reads ONE representative file's header per
  folder (first that opens cleanly, trying up to 5 before giving up) —
  deliberately not every file, matching this app's existing
  filename-based detectors' "one cheap sample is representative enough"
  philosophy, and confirmed fast in practice (~35ms round trip
  including the browse listing itself). `/captures/browse` now also
  returns `sample_date_obs`/`sample_instrument`. Frontend: extended the
  same per-session `updateSessionWarnings()` this app already uses for
  the lights/flats and exposure mismatches, adding flats-vs-lights date
  (>1 day) and camera, and darks/bias-vs-lights age (>365 days older or
  >30 days newer, boundary-tested to land exactly on "more than," not
  "at least") and camera — all combined into the same one warning
  message per session, non-blocking, same as every other check here.
  Refactored `attachFolderBrowser()`'s `onSelect` callback from
  positional args to a single data object while touching every call
  site anyway, since it was about to grow past a sane number of
  positional params. Verified against real data: matched same-session
  OSC lights+flats shows nothing; MC lights against real MM flats
  (wrong camera AND ~1 year apart) shows both messages combined; a
  same-camera, realistic ~17-day calibration gap shows nothing; MC
  lights against MM darks (wrong camera only, no date issue) shows only
  the camera message.
- ✅ **Versioning introduced (2026-09-23)** — see the new Architecture
  decisions bullet for the full policy. `config.VERSION` bumped to
  `"0.4"`; `v0.3` tagged and pushed on the already-deployed `e75349d`.
  Verified the header shows `v0.4` and `/health` returns it, live.
- ✅ **Narrowband/mono workflow redesigned around one-click multi-filter
  staging and stacking (2026-09-23)**. Chris: "rather than requiring 4
  separate stacking sessions... we allow the user to stage images for
  each of the filters that they've used... [does this] require some kind
  of branch... or can we subtly add it in more easily and use context
  clues?" **Answer given and confirmed correct while building this**: no
  branch needed. The (night × filter) model this asks for was already
  how the backend worked, one filter-picker click at a time (last
  round's work) — `is_osc` plus filename-based filter detection were
  already sufficient context; the only real gap was staging-step UX,
  since Masters (one flat per session) and Review (already listed/
  labeled per session) already fan out correctly the moment sessions are
  correctly split by filter, with zero code changes needed there.
  Built:
  - **Stage**: a mixed-filter folder pick (e.g. narrowband H/O/S all in
    one "Light" folder) now shows a multi-select checklist (all filters
    checked by default) instead of last round's single-select dropdown.
    One "Stage files" click fans that ONE row out into one NightSource
    PER CHECKED FILTER, all pointed at the same source folder pair —
    replacing what used to require repeating "+Add session" once per
    filter. Verified: one folder pick with 2 of 3 filters checked
    produced exactly 2 correctly-filtered sessions server-side.
  - **Stack**: Chris chose auto-fan-out (asked directly, since this was
    a genuine design fork, not something to assume) — selecting nights
    that span multiple filters and clicking "Run stack" once now groups
    them by filter and runs one independent stack per group,
    *sequentially* (the server already 409s a second job against the
    same project while one runs — shared scratch dirs — so firing them
    concurrently was never an option), with a live per-group status
    trail ("✓ H complete", "Running S (2/2)…"). Verified for real: 2
    filters staged and mastered, one "Run stack" click produced 2
    separate, correctly-named result files
    (`<project>_H_<time>.fit`/`<project>_S_<time>.fit`).
  - **Found and fixed a real collision this surfaced**: the merge
    scratch dir (`process/lights/_merged`) was a single project-wide
    path, wiped fresh (`shutil.rmtree`) before every merge run — so
    stacking a second filter after the first would have deleted the
    first filter's completed result right off disk despite its
    different filename, since the whole directory gets rebuilt, not
    just the file in question. Fixed by suffixing the dir with the
    filter set (`_merged_H`, `_merged_H+S` for an overridden mixed
    selection, plain `_merged` when no night carries a filter — kept
    unsuffixed specifically so existing OSC projects' paths don't
    change). `status.py`'s single `merged_result_filename` similarly
    became `merged_result_filenames` (dict keyed the same way,
    `/status` now returns a `merged_results` list instead of one path)
    so a project can have several live merged results at once instead
    of the newest silently overwriting the meta record of the previous
    one. Verified backward compatibility for real: re-ran an OSC 2-night
    merge against `live-test-8` (no filter involved at all) end-to-end
    and confirmed it still uses the original unsuffixed path and reports
    correctly through the new list-shaped `merged_results`.
  - **Stack's result preview became a gallery** (`allResultEntries()` /
    `showStackPreview()`), showing every currently-existing result at
    once (each merged group plus any standalone single-night results,
    deduped by path) instead of assuming there's only ever one — each
    card labeled by filter (or by night, for an unmerged single-filter
    result), with its own download link, sharing one stretch-mode
    toggle. Verified the gallery renders both filters' results with
    correct labels and images after a real fan-out stack.
  - **Also found and fixed a latent bug from the calibration-optional
    round**, unrelated to filters but caught while reading this code:
    `mastersComplete` (the gate that unlocks the Stack step) required
    `master_bias_built`/`master_dark_built` unconditionally — meaning a
    project with NO bias/dark staged at all (exactly the narrowband test
    data, and any legitimately calibration-frame-free project) could
    never satisfy it and would stay PERMANENTLY locked out of Stack
    through the UI, even though the backend has handled this correctly
    for two rounds now. Fixed: bias/dark only count as "required" when
    any were actually staged (`biases_count`/`darks_count` > 0).
- ✅ **Review/checklist labels fixed, and multi-night multi-filter
  grouping designed and built (2026-09-23)**. Chris caught a real
  regression from last round's narrowband work: Review's per-session
  blocks were labeled with the raw internal key ("night1", "night2",
  ...) instead of the descriptive label every other view already used —
  `renderAnalyzeOutput()` was building its heading from the bare object
  key straight out of `state.lastAnalyzeResult.nights`, bypassing
  `nightDisplayLabel()` entirely. Also asked for the filter to be part
  of the FULL name (`date-target-camera-telescope-filter`, e.g.
  `2025-10-04-HeartNebula-2600MM-WO61-H`) rather than last round's
  parenthetical suffix, and for "Nights to analyze"/"Nights to build
  flats for"/"Nights to stack" to stop calling a (night, filter) session
  a "night" — renamed to "Sessions..." throughout (matching Stage's own
  existing "Add a session" terminology), including the Masters
  calibration-alignment card title/hint and the exclude-frames hint.
  Also fixed the Stack panel's filter-mismatch note, which was left over
  from BEFORE last round's auto-fan-out and had gone stale in the same
  round that built the fix: it still said "merging different filters
  into one stack doesn't make sense," when the app now correctly handles
  exactly that by running one stack per filter instead of merging them —
  reworded from a warning to an informational heads-up about what the
  fan-out is about to do.
  **The harder ask**: Chris asked me to think through the case where a
  project has SEVERAL nights, each with several filters, that don't
  necessarily match (night 1 shot in S/H/O/L/R/G/B, night 2 just H/O,
  etc.) — since each (night, filter) combo is its own independent
  session, a project like that can easily have a dozen+ entries, and
  listing them in raw staging order buries "all my H data" across
  however many other filters/nights sit between them. **Decision**: group
  by FILTER (not night), since filter is the unit Stack actually combines
  nights INTO — this directly answers the question these views exist to
  answer ("is my H data, across every night I have it, ready?") in a way
  night-first grouping wouldn't. Built one shared `groupNightsByFilter()`
  (`app.js`) used by all three per-session checklists (Masters/Review/
  Stack) AND Review's own per-session output blocks — a plain OSC
  project (no filters at all) gets zero group headings, completely
  unchanged from before this existed; a project with any filter data
  gets a "Filter: X" heading (chip-row full-width break for the compact
  checklists, a bigger rule-line heading for Review's larger blocks)
  ahead of every filter's sessions, sorted alphabetically with any
  filterless sessions pushed last. Verified for real: staged 3 sessions
  across 3 filters from the same physical night, confirmed all three
  checklists AND Review's analyzed output group identically under
  "Filter: H"/"Filter: O"/"Filter: S" with full descriptive labels, then
  re-verified a plain OSC project (`live-test-8`) still shows a flat,
  ungrouped list exactly as before.
- ✅ **Review results now survive a page reload / brand new session, not
  just switching projects within one open tab (2026-09-23)**. Chris:
  "It looks like we've lost our light frame history when I exit and go
  back into a project." Reproduced carefully before assuming where the
  bug was: switching projects (or to "no project") and back WITHIN one
  still-open tab worked fine — the existing `reviewCache` (client-side,
  in-memory JS object) already handled that case correctly, confirmed by
  testing it directly. The actual gap: `reviewCache` is pure browser
  memory, so it was ALWAYS wiped by anything Chris would actually
  describe as "exit and go back in" — a page reload, a new browser tab,
  or the dev container restarting — since analyze results were never
  persisted anywhere outside that one JS object, by original design
  ("nothing is persisted server-side" — but that decision was about not
  auto-excluding frames, not about storing the data at all; conflating
  the two is what left this gap).
  Fixed with real server-side persistence: `run_analyze()`'s job writes
  `project/review_state.json` (`{result, anomaly_sigma,
  exclude_frames}`) the moment it succeeds — the expensive part (real
  astropy/photutils compute per frame) is now saved exactly once,
  unconditionally, with no dependence on the client ever "switching
  away" first. New `config.read_review_state()`/`write_review_state()`/
  `delete_review_state()` (deliberately a separate file from meta.json,
  which documents itself as being for a handful of small settings, not
  potentially-large per-frame data) back three new endpoints: `GET`/
  `POST`/`DELETE /projects/{name}/review-state`. The frontend's
  `switchToProject()` now falls back to `GET .../review-state` whenever
  there's no in-memory `reviewCache` hit (a fresh tab/reload), restoring
  the same way either path arrived; exclude-list/sensitivity changes
  made after the fact are pushed to `POST .../review-state`
  fire-and-forget at the same point `reviewCache` already gets updated
  (switching away). Also caught and fixed the same class of bug in
  "Start over," which already knew to clear the in-memory cache
  (specifically to prevent resurrecting pre-reset data on switch-away-
  and-back) but had no way to know about the new server copy — without
  clearing it too, "Start over" followed by a page reload would have
  silently un-done the reset. Verified for real, not just re-reading the
  code: analyzed a real project, excluded a frame, closed the tab
  entirely (`Target.closeTarget`, not just navigating away) and opened a
  completely fresh one — full result (30 frames, 3 sessions) and the
  exclude count both came back correctly; separately verified "Start
  over" followed by a fresh tab shows "not analyzed" with nothing
  resurrected.
- ✅ **Stage auto-populates a best-effort staging plan from the chosen
  root folder (2026-09-24)**. Chris: pick a root folder, get lights (per
  night/filter), matching flats, and darks/biases pre-populated where
  findable, so there's a subset to review and prune instead of clicking
  through the folder picker once per field. Also asked for real
  protective logic — a max depth, and not guessing across folders that
  "clearly apply to different projects."
  **Design choice, made deliberately**: every candidate comes from
  INSIDE the chosen root only (never searches the wider captures
  library), and a flats folder is only ever paired with a lights folder
  that's its own SIBLING (same parent directory) — never guessed across
  folders that happen to both look like flats but belong to different
  sessions. This is what actually delivers the "don't cross-match
  unrelated projects" safety Chris asked for, without needing a separate
  fuzzy name-similarity heuristic bolted on top: confining every
  candidate to the explicitly-chosen root plus same-parent-only flats
  pairing leaves no cross-project ambiguity to guard against in the
  first place. `darks_dir`/`biases_dir` are only proposed when exactly
  ONE candidate of that type was found anywhere in the scan — two or
  more (e.g. a per-night darks folder) is genuinely ambiguous for a
  single shared field, so it's left blank rather than guessing wrong.
  New `app/autostage.py` walks the root up to `MAX_DEPTH=3` (chosen
  from, and confirmed sufficient for, every real layout in the test
  data — target→dated-session→[Night N]→lights/flats is at most 3
  levels either way this app has actually seen it staged), capped at
  200 folders checked as a defensive limit against a pathological tree.
  New `GET /captures/scan` backs it, reusing the exact same
  `frameinfo.detect_frame_type()` 90%-agreement rule already used for
  every other filename-based check in this app, so a folder only counts
  as a candidate if that same rule already trusts it. Frontend:
  triggered automatically right after picking a root folder during
  project creation (the one place root_dir already gets set) —
  `addNightRow()` now takes an optional pre-filled `{lightsDir,
  flatsDir}` and, for each, runs the picked path through the EXACT SAME
  `/captures/browse` fetch + type/exposure/date/camera warning checks
  and filter-detection a manual folder-browser pick would (refactored
  the biases/darks pick handlers into named functions,
  `onBiasesPicked`/`onDarksPicked`, so the scan path and the manual
  picker path share one implementation instead of two copies that could
  drift). An amber note appears when anything was auto-populated,
  telling Chris to review before staging; every proposed field remains
  fully editable/removable through the exact same UI a manual pick uses
  — this only ever saves clicks, never bypasses review. Verified against
  every real layout in the test data: a multi-night OSC root correctly
  proposed both nights with matched flats and no false calibration
  guesses; a mixed-filter narrowband root correctly proposed the one
  session AND triggered the existing H/O/S filter checklist exactly as
  a manual pick would; a target-level root (containing two completely
  different camera sessions as siblings) correctly proposed both without
  cross-contaminating them. Known, accepted limitation: the real
  calibration-frame library's actual folder depth (`Dark/<camera>/
  <exposure>/<date>/`) exceeds MAX_DEPTH from that library's OWN root —
  not fixed, since root_dir is meant to point at a target, not the
  shared calibration library, and every real target-rooted scan already
  correctly finds nothing there (which is the honest, expected answer,
  not a bug) rather than reaching across into unrelated territory.
- ✅ **Auto-populate follow-up: real numbering bug fixed, folder-info
  summary added, and a genuinely serious cross-project leak caught along
  the way (2026-09-24)**. Chris hit a real bug testing the auto-populate
  feature the same day it shipped: staging an OSC project (exactly one
  session) put the real data in "Session 2" with an empty "Session 1"
  ahead of it. Root cause: `switchToProject()` already seeds one blank
  draft row for every project before Stage is ever shown, and
  `autoPopulateFromScan()` was just APPENDING its own rows after that
  one instead of accounting for it. Fixed: before adding auto-detected
  sessions, remove any still-blank draft row(s) first, then renumber.
  Also asked for a summary above each Lights/Flats/Biases/Darks picker
  showing at minimum frame count, plus exposure and date "if it can fit
  nicely" - added `formatFolderSummary()` (`app.js`), rendering e.g. "15
  frames · 300s · 2026-09-16" from the exact same `/captures/browse`
  response (`fit_count`/`detected_exposure_s`/`sample_date_obs`) every
  picker already fetches - no new backend work needed, purely a display
  addition. Wired into every path that can set one of these four fields:
  the interactive folder browser, Stage's auto-populate, AND the
  `addNightRow(initial)` pre-fill path added for auto-populate.
  **Caught a real, more serious bug while wiring the biases/darks
  summary in**: `biases-dir`/`darks-dir` (and now their new summary
  lines) are plain static inputs, not recreated per project the way
  session rows are - and `switchToProject()` never reset them. Confirmed
  live: set a biases path on project A, switch to project B (nothing
  staged), and project A's path was still sitting there. Not just
  cosmetic - clicking "Stage files" without noticing would have
  re-staged the WRONG project's calibration frames into the new one.
  Fixed as part of the same edit (cleared on every switch, along with
  their warnings and the module-level sample-date/instrument/exposure
  variables that back the cross-field mismatch checks). Verified all
  three fixes live: a real single-session OSC auto-populate now produces
  exactly one correctly-numbered "Session 1" with both summaries shown;
  the cross-project leak test (set biases on A, switch to B) now comes
  back empty on both the field and its summary.
- ✅ **Real bug: project names containing spaces broke every `.ssf` step
  (2026-09-24)**. Chris hit "Failed: step 1/3 (master_bias) failed" on a
  real project named "Test OSC Project 1". Root-caused via the actual job
  log (`GET /jobs/{id}/log`): `Unknown parameter OSC, aborting.` /
  `Error in line 8 ('convert'): invalid arguments.` Confirmed via
  `POST /projects/{name}/masters/render` that the rendered script
  contained `convert bias -out=/data/projects/Test OSC Project
  1/process/_build/bias` - unquoted, and Siril's script parser
  tokenizes `-out=`/`-dark=`/`-flat=`/`-bias=` style arguments on
  whitespace with NO quoting escape hatch (unlike plain `cd "path"`,
  which does honor quotes - this asymmetry was already noted in the
  codebase's own prior comments, just not yet enforced at the point
  where it actually matters: project naming). Every `.ssf` template
  bakes the project's own directory path into one of these unquoted
  options, so this wasn't master_bias-specific - it would have broken
  every step for any project name containing a space; master_bias just
  happens to run first. Fixed in `config.project_dir()`: names must now
  match `^[A-Za-z0-9._-]+$` (letters, numbers, hyphens, underscores,
  periods only), raising the same `ValueError` → HTTP 400 path that
  already existed for `.`/`..`/path-separator rejection - no changes
  needed in `main.py`. Mirrored client-side in the `create-project-btn`
  handler (`app.js`) so an invalid name is caught before the folder
  picker even opens. Verified live via the running container: `Test` and
  `mono-project-1` (both space-free) still resolve and return 200 from
  `/status`; `Test OSC Project 1` and a fresh `Bad Name Here` both now
  get a clean 400 with a clear message instead of a cryptic Siril
  failure three steps in. Chris's existing "Test OSC Project 1" project
  is left as-is (no rename feature exists) - it's understood to be test
  data, so the fix going forward is to delete it and recreate with a
  dash/underscore name instead of spaces.
- ✅ **Mono staging: per-filter frame counts, then redesigned into one row
  per filter after Chris flagged the checkbox layout itself (2026-09-24)**.
  First pass: Chris asked for the number of frames per filter on the
  mono/narrowband staging path, not just the folder's total.
  `detect_filters()` (`frameinfo.py`) previously only returned which
  filter codes were present (e.g. `["H","O","S"]`) with no counts. Added
  `count_filters()` alongside it (same filter-code parsing, tallies
  instead of just collecting distinct codes), exposed as a new
  `filter_counts` field on `/captures/browse` (e.g. `{"H":10,"O":10,
  "S":10}`). Initially wired into the existing inline-checkbox picker so
  each label read "H (10)" instead of just "H" - but Chris pushed back on
  the design itself: (1) the "filters to stage from this folder"
  wording/layout treats lights+flats as one folder when they're really
  two, and (2) a wide row of checkboxes doesn't scale - a real project
  can easily use all of L/R/G/B/H/S/O, and 7 checkboxes crammed onto one
  line isn't usable. Redesigned: lights and flats now track their own
  detected filters/counts separately (`lightsDetectedFilters`/
  `flatsDetectedFilters`/`lightsFilterCounts`/`flatsFilterCounts`),
  merged by `refreshFilterRows()` (replaces the old
  `applyDetectedFilters()`) into ONE FULL-WIDTH ROW PER FILTER (new
  `.filter-group`/`.filter-picker`/`.filter-picker-row` CSS - each row
  breaks onto its own line via `flex-basis:100%`, same trick already used
  for `.checklist-group-heading`), each showing that filter's own counts
  from BOTH folders side by side (e.g. "10 lights · 10 flats") so it's
  visually obvious two real folders back every filter, not one. Group
  label changed from "Filters to stage from this folder" to "Filters in
  this session". Verified live via CDP against the real HeartNebula
  2600MM mono session data (30 Light + 30 Flat frames, H/O/S mixed in
  each): after picking both folders, three separate filter rows render,
  each correctly reading "10 lights · 10 flats", checked by default, full
  width rather than cramped side-by-side.
- ✅ **Clear/unselect button for Biases dir and Darks dir (2026-09-24)**.
  Chris hit an inadvertent bias pick with no way back to "nothing
  selected" - picking a DIFFERENT real folder works, but there was no
  clean way to fully unselect (both are optional - staging with neither
  is a normal, supported case per the stage-btn handler's `|| null`).
  Added a small "✕" clear button next to each Browse button
  (`biases-clear`/`darks-clear` in `index.html`). Wired to two new
  functions in `app.js`, `clearBiases()`/`clearDarks()`, which reset the
  input value, the frame-count summary, the type-mismatch warning, and
  the sample-date/instrument/exposure tracking variables that back the
  cross-field mismatch checks - the exact same reset `switchToProject()`
  already needed when leaving a project (that block now just calls these
  two functions instead of duplicating the reset inline). Verified live
  via CDP: picking the real 10-frame bias folder ("10 frames · 1ms ·
  2026-08-29") then clicking clear empties both the field and summary;
  same for a real 10-frame 300s darks folder; clicking clear with nothing
  selected is a harmless no-op (no exceptions).
- ✅ **Major redesign: darks moved from one project-wide picker to
  per-session, deduplicated by exposure length; OSC gained the same
  filter-style splitting mono already had; the mixed-filter checkbox
  picker was removed entirely (2026-09-24)**. Chris realized real
  narrowband/mono projects commonly use different LIGHT exposure lengths
  per filter, meaning each filter needs its own matching master dark, not
  one shared dark for the whole project (the previous architecture) - and
  that OSC projects can hit the identical problem (differing exposures
  within one night or across nights). He also flagged that the
  immediately-prior round's "one row per filter" checkbox UI (see the
  "Redesigned into one row per filter" bullet above) still implied one
  shared folder when there are really two or three, and doesn't scale
  past a handful of filters. Two explicit design decisions locked in
  before implementing: (1) unify OSC and mono under ONE model - every
  light-frame group, whether a mono filter or a plain OSC session, gets
  its own dark picker; (2) darks sharing the same exposure length must
  share ONE built master, never rebuild redundantly per row/session -
  "these modifications don't automatically mean that every row requires a
  separate dark stack."

  **Data model** (`app/models.py`): `NightSource` gains `darks_dir`
  (mirrors `flats_dir`) and `exposure_s` (mirrors `filter`, but for OSC -
  tags which exposure length this session's lights should be culled to
  when a lights folder mixes more than one). `StageProjectRequest.darks_dir`
  (the old project-wide field) is gone; `biases_dir` is completely
  untouched (there's still no scenario needing different bias frames
  within one project).

  **Staging** (`app/staging.py`): darks now link into
  `raw/nights/<name>/darks` per session (same `_link_dir()` mechanism
  already used for lights/flats). Caught a real bug while first testing
  this: darks were initially filter-culled the same way lights/flats are
  - but real dark frames carry NO filter code in their filename at all
  (shot with the shutter closed, independent of any filter), so every
  darks stage attempt immediately 0-matched and hard-errored. Fixed:
  darks are staged unculled - a picked darks_dir is presumed to already
  BE the correct, self-contained set for that session, unlike a
  legitimately-mixed lights/flats folder. `exposure_s` DOES cull lights
  (not flats - a flat's own exposure is unrelated to the light sub length
  it calibrates).

  **Dark master dedup** (`app/ssf.py`, the actual mechanism satisfying
  Chris's second requirement): new `dark_exposure_key()` reads a night's
  own staged `raw/nights/<name>/darks` filenames and returns
  `frameinfo.detect_exposure_seconds()`'s result as a grouping key (e.g.
  `"300s"`), or `None` if undeterminable (that night becomes its own
  singleton group - safer than risking a bad merge). `render_build_masters()`
  groups every night by this key and builds exactly ONE master dark per
  distinct group - when 2+ nights share a key, ALL of their raw dark
  frames get symlinked into one shared scratch input
  (`process/_build/darks/<key>_input/`, a SIBLING of the actual output
  scratch dir, not nested under it - nesting it under the `fresh_dir`
  that `prepare_fresh_dirs()` wipes right before the job runs would have
  deleted the merged input out from under itself) before building, so a
  shared master also benefits from MORE combined frames rather than
  arbitrarily using just one contributing night's subset. Output:
  `process/darks/<key>/master_dark.fit`. `_resolve_nights()`'s dark
  default fallback now resolves to this same per-night, per-key path
  (mirrors flat's already-existing per-night default). `app/status.py`
  drops the old project-wide `darks_count`/`master_dark_built` in favor
  of per-night `dark_count`/`master_dark_built`/`dark_key` (the last one
  lets the frontend build the correct shared preview path itself, the
  same way it already derives a flat's path purely from the night name).
  Also fixed a correctness gap this surfaced: `merged_result_filenames`
  (multi-night stack result tracking) was keyed by filter only, empty
  string for every OSC result - two DIFFERENT OSC exposure-group stacks
  would have collided on that same empty key and overwritten each other's
  record. Now falls back to an exposure-based key
  (`ssf.py`'s `_resolve_nights()`'s `merge_dir_name`, and `main.py`'s
  `run_stack()`'s `merge_key`) the same way filter already does, so an
  OSC project's 60s merge and 300s merge can coexist.

  **Frontend row redesign** (`static/app.js`/`index.html`/`styles.css`):
  the global "Darks dir" field is gone entirely; the mixed-filter
  checkbox picker (`refreshFilterRows()`/`.filter-group`/`.filter-picker`)
  is also gone entirely, per Chris's explicit call ("get rid of the
  checkbox UI and show a row per filter, whether they are in the same
  folder or nested deeper"). Every session row (`addNightRow()`) now has
  its own Lights/Flats/Darks pickers (three `.dirpick-group`s, same CSS,
  no new picker styling needed) plus a clear button for darks. A folder
  resolving to 2+ filters (mono) or - new - 2+ light exposure lengths (OSC,
  via new `detected_exposures`/`exposure_counts` on `/captures/browse`,
  mirroring `detected_filters`/`filter_counts`) auto-splits into that many
  independent rows (`splitRowByFilters()`/`splitRowByExposure()`), each
  tagged via `row.dataset.filter`/`.exposureS` (singular now - the old
  plural comma-joined `dataset.filters` checkbox list is gone). A `splitDone`
  flag guards a real race: lights and flats fire independent browse
  callbacks, and without it, both resolving in quick succession (e.g. from
  `autoPopulateFromScan()`'s concurrent fetches) could each trigger their
  OWN split and double the resulting rows. **Cross-row darks auto-fill**
  (`autoFillMatchingDarks()`, tracked via a new shared `nightRows` array):
  once any row's darks resolve to an exposure length, every OTHER row
  whose own lights share that exposure AND whose darks field is still
  EMPTY gets filled in too - never overwrites an already-set field, and
  does nothing if candidates disagree on which folder to use (same
  "can't tell isn't wrong" rule used throughout this app). A new
  `.dirpick-provenance` caption (small/muted/italic, same treatment as
  `.dirpick-summary`) distinguishes a manual pick (blank) from a
  scan-proposed one ("Found automatically at this path") from a cross-row
  match ("Matched from Session N (Xs exposure)"), so a pre-filled value is
  never a mystery about where it came from. The stage-btn handler's
  positional `querySelectorAll("input")[0]`/`[1]` indexing (would have
  silently broken the moment a third input existed) is replaced with
  reading directly from `nightRows`' tracked refs. Caught and fixed a
  second real pre-existing gap while wiring `nightRows` in:
  `switchToProject()`'s project-switch reset wiped `#stage-nights`'
  innerHTML directly without ever calling any row's own cleanup, so
  `nightRows`/`sessionWarningUpdaters` silently accumulated stale entries
  from every previous project - harmless for the warnings array (it only
  recomputes on detached, invisible nodes) but a real correctness risk for
  `nightRows` once it's used to auto-fill one row's darks from another
  (a stale entry could bleed a previous project's exposure/darks match
  into the new one's rows). Both arrays are now explicitly cleared there.

  **Scanner enhancement** (`app/autostage.py`), applied to BOTH darks and
  flats pairing per Chris's explicit "upgrade flats too" call: replaced
  flats' old sibling-only pairing (and darks'/biases' old "propose only if
  exactly one candidate exists anywhere" global rule) with a shared
  4-rule cascade (`_pair_dir()`/`_apply_leftover_fallback()`) tried in
  priority order per light folder: (1) nested subfolder (a Dark/Flat
  folder living directly inside the Light folder), (2) sibling parent
  (today's original flats rule - same parent directory), (3)
  normalized-path match (`_normalize_parts()` strips frame-type keywords
  from each path's parts before comparing - catches parallel branches
  like `Project/Light/H` vs `Project/Dark/H`, the exact case Chris
  described, where the parents differ so rule 2 can't reach it), (4) a
  single leftover candidate project-wide, fanned out to every session
  still missing one (generalizes the old global rule per-session instead
  of filling one shared field). Two or more leftover candidates stays
  genuinely ambiguous - left blank, not guessed. `biases_dir` (top-level,
  singular, unchanged) still uses the plain "exactly one anywhere" rule
  directly, with no per-session fan-out, since biases are never
  per-session.

  **Verified thoroughly** (existing test projects deleted/recreated, not
  migrated, since the raw/ layout changed shape - matches this session's
  established pre-1.0 practice for breaking changes): curl-verified the
  dark-dedup mechanism directly (two nights sharing a picked 300s darks
  source correctly produced exactly ONE `process/darks/300s/master_dark.fit`,
  both nights' `/status` reporting `master_dark_built: true` against it;
  a third night with no darks at all cleanly reports `false`, no error).
  CDP-verified the full real UI flow end to end: picking a real mixed H/O/S
  narrowband Light folder correctly split into 3 independent rows, each
  with its own working Lights/Flats/Darks pickers; picking darks on just
  one of the three correctly auto-filled the other two with the
  "Matched from Session N (300s exposure)" caption; staging all three
  through the actual Stage button and building masters through the actual
  Masters step correctly showed exactly ONE "Master Dark" preview tile
  labeling all three sharing sessions, alongside three separate "Master
  Flat" tiles. Unit-tested the new scanner cascade directly against
  synthetic trees (bypassing the read-only `/captures` mount): the
  `Project/Light/H`+`Project/Dark/H` parallel-branch case correctly
  paired via rule 3; a single shared unstructured darks folder correctly
  fell back (rule 4) to both of two sibling-paired sessions; two
  structurally-unrelated darks candidates correctly stayed unassigned
  (genuinely ambiguous, not guessed).
- ✅ **Stage UI polish pass after the per-group darks redesign, plus a
  real bug fix (2026-09-24)**. Chris reviewed the redesign and asked for
  nine cleanups, top to bottom:
  1. "Add a session" copy now mentions darks too ("Add a group (lights,
     flats, and matching darks)").
  2. Renamed "session" → "group" everywhere in the Stage/Masters/Review/
     Stack UI text ("Group N", "+ Add group", "Groups to build darks/
     flats for", etc.) - internal function/variable names left alone
     (`updateSessionWarnings()`, `sessionWarningUpdaters`, plain-English
     "session" in warning messages) since they're invisible to Chris and
     renaming them had no visible benefit. Each group's label is now also
     **annotated** with whatever actually makes it distinct - "Group 1 —
     Filter H", "Group 2 — 300s", or (a plain single-group OSC project
     with nothing to disambiguate) the picked lights folder's own parent
     name - via a new `updateGroupAnnotation()`, called after every lights
     pick and right when a split assigns a filter/exposure tag.
  3. Picker layout evened up: `lightsGroup`/`flatsGroup`/`darksGroup` (and
     the biases field in `index.html`) now put the input+browse row
     directly under the label, with the frame-count/exposure/date summary
     and the darks provenance caption moved BELOW it - so all three (four,
     counting biases) pickers' actual input boxes line up at the same
     height regardless of how many detail lines happen to be showing.
     Verified via CDP bounding-rect check: all three `.dirpick-row`s in a
     group sit at the identical `top` pixel position.
  4. Dropped "(optional)" from the Darks label - it's just "Darks" now,
     matching "Flats"' plain label (the `placeholder="optional"` text
     inside the empty input stays, per Chris - that's fine, it's the
     label itself that shouldn't call it out specially).
  5. **Removed the standalone per-row darks "✕" clear button** (Chris:
     "the multiple X buttons at the right is confusing" - it sat right
     next to the group's own remove "✕"). `attachFolderBrowser()` gained
     an optional `{ onUnselect }` param that adds a third "Unselect"
     button alongside "Use this folder"/"Cancel" in the SAME browse popup;
     darks' picker passes `clearDarksForRow` as `onUnselect`, so a row now
     has exactly one button (the browse "…") and all three choices live
     inside the one popup Chris asked for.
  6. **Fixed a real bug this surfaced**: "the unselect darks function is
     broken when another session auto matches to it." Root cause: the old
     darks-clear handler called `autoFillMatchingDarks()` right after
     clearing (reasoning at the time: "this row is empty again - maybe
     another row can now fill it") - but if another row still had the
     SAME matching-exposure darks value set, that immediately refilled
     the just-cleared row right back, making Unselect look like a no-op.
     Fixed by never calling `autoFillMatchingDarks()` after a clear/
     unselect - Unselect is now the user's own final word on that row,
     never immediately re-triggered. Verified live via CDP: 3 split rows,
     manually pick darks on row 1 (auto-fills rows 2 and 3 with the same
     value, as designed), then Unselect row 1 - row 1 goes back to empty
     and STAYS empty, rows 2/3 keep their own values untouched.
  7. Biases label changed to "Biases (shared across all groups)" (was
     "Biases dir (shared across every session)").
  8. **Internal naming**: the auto-generated group name prefix changed
     from `night1`/`night2` to `group1`/`group2` - purely a frontend
     change (`nextGroupNumber()`/the stage-btn handler's
     `` `group${nextNum++}` ``), since the backend already treats a
     group's `name` as an opaque string throughout (staging.py, ssf.py,
     status.py just enumerate whatever's on disk) - no backend code
     needed to change at all. `nextGroupNumber()`'s existing-name regex
     now matches BOTH `group` and the old `night` prefix, so a project
     with groups staged before this rename still numbers new ones
     correctly instead of restarting at 1. Verified end-to-end via CDP: a
     freshly staged 3-group project reports `name` as `group1`/`group2`/
     `group3` from `/status`.
  9. **New OSC/mono mismatch warning**: real filter-code evidence in ANY
     group's lights (mono/filter-wheel proof - see
     `frameinfo.parse_filter()`) while the OSC checkbox is still checked
     now shows a warning right under it. Deliberately ONE-DIRECTIONAL -
     no warning for "no filter evidence + OSC unchecked," since plenty of
     legitimate mono setups never encode a filter code in their filenames
     at all (the same already-accepted limitation behind the "no manual
     filter-override UI" decision from the redesign) - warning there would
     just be noisy false positives on ordinary, correctly-configured mono
     projects. Checks both the current draft rows AND already-staged
     groups (in case OSC gets toggled after the fact), re-evaluated on
     every filter-detection change, group add/remove, and OSC checkbox
     toggle. Verified via CDP: warning appears exactly when mono/filtered
     data is staged with OSC checked, and clears the instant OSC is
     unchecked.
- ✅ **Follow-up polish round: frame-count accuracy, picker alignment, and
  Unselect consistency (2026-09-24)**. Chris caught three more issues
  right after the previous polish pass shipped:
  1. **Frame counter was inaccurate after a split**: a mixed H/O/S folder
     (30 frames total, 10 each) correctly split into 3 groups, but each
     group's Lights/Flats summary still showed "30 frames" instead of
     that group's own locked-filter subset (10). Root cause:
     `formatFolderSummary()` just echoed `data.fit_count` - the raw,
     whole-folder count from `/captures/browse` - with no awareness of
     the row's OWN filter/exposure lock, which only gets decided
     (`row.dataset.filter`/`.exposureS`) by `maybeSplitRow()` running
     AFTER the summary was already written. Fixed: `formatFolderSummary()`
     takes an optional `{count, exposureS}` override; new
     `refreshLightsSummary()`/`refreshFlatsSummary()` (in `addNightRow()`)
     recompute the summary from the row's CURRENT filter/exposure lock
     against `lightsFilterCounts`/`flatsFilterCounts`/
     `lightsExposureCounts` (looked up by value with the usual 0.01
     tolerance, not exact key string match, since a Python float dict key
     round-trips through JSON as text - `"300.0"` - and doesn't line up
     with `String(300)`), called AFTER `maybeSplitRow()` decides the
     row's fate rather than before. A locked filter/exposure with
     literally zero matching frames now shows "0 frames" (matching the
     warning already shown) rather than silently falling back to the
     misleading whole-folder total. Verified live via CDP: a split
     H/O/S row now shows "10 frames · 300s · ..." on both its Lights and
     Flats summaries, not 30.
  2. **Picker alignment broke the moment summaries appeared**: Chris:
     "when lights and flats are selected and the info pops up beneath the
     picker, the dark picker no longer aligns... those boxes should all
     be the same height from the top." Root cause: `.night-row`'s
     `align-items: center` vertically CENTERS each Lights/Flats/Darks
     column against the tallest one in that flex-wrap line - so once
     Lights+Flats grew taller (their summaries now showing) than Darks
     (still empty), Darks' shorter column got centered against theirs,
     shifting its own input+browse row down out of alignment. One-line
     fix: `align-items: flex-start` - every column's content now starts
     at the identical top offset regardless of height, and the row simply
     grows downward to fit the tallest column, exactly as Chris described.
     Checked every other place `.night-row` gets reused (the folder-
     browser popup's list items, `renderExistingStagedNights()`,
     `renderCalibrationAlignment()`) - all single-line-height content,
     unaffected by the change. Verified via CDP bounding-rect check: all
     three `.dirpick-row`s sit at the identical `top` pixel even with
     Lights+Flats summaries showing and Darks still empty.
  3. **Unselect consistency**: `attachFolderBrowser()`'s `{onUnselect}`
     option (added for darks in the previous round) is now also wired
     into Flats (new `clearFlatsForRow()` - clears flats' own tracked
     state but deliberately leaves the row's filter/exposure lock alone,
     since that's decided by lights, not flats) and Biases (the existing
     `clearBiases()` passed straight through as `onUnselect` - no new
     function needed). The standalone `#biases-clear` "✕" button is
     removed from `index.html`, matching darks. Every picker in a group
     row (Lights/Flats/Darks) and the Biases field now have exactly ONE
     button each (the browse "…"), with "Use this folder"/"Cancel"/
     "Unselect" all living inside that one popup - confirmed via CDP that
     a group row has exactly one row-level "✕" left (the group's own
     remove button), nothing else.
- ✅ **Two real bugs: stale Review cache surviving a delete+recreate, and
  a wrong stretch algorithm for OSC bias/dark previews (2026-09-24)**.

  **Bug 1 — delete a project, create a new one with the SAME name, and
  Review already had the OLD project's images.** Root cause: the
  delete-project-btn handler correctly did `delete reviewCache[name]`
  right after a successful delete, but then set `sel.value = ""` and
  dispatched a `change` event to deselect — which calls
  `switchToProject()`. That function's OWN first block ("save the
  OUTGOING project's review session") runs unconditionally whenever
  `state.project && state.lastAnalyzeResult`, with NO awareness that the
  project it's about to save FOR was just deleted a moment ago -
  `state.lastAnalyzeResult` was still holding the just-deleted project's
  analyze result (Chris was actively looking at Review when he deleted
  it), so this immediately re-wrote `reviewCache[name]` right back,
  undoing the clear that had just happened. Creating a new project with
  the same name later then restored this resurrected entry via the
  ordinary (and otherwise entirely correct) name-keyed cache-restore path
  in `switchToProject()`. Fixed by clearing `state.lastAnalyzeResult`/
  `state.excludeFrames`/`state.lastAnomalySigma` immediately after a
  successful delete, before the subsequent `dispatchEvent` - the outgoing
  -save block then correctly sees nothing to save and skips it entirely.
  Verified via CDP (simulating an active analyze result rather than
  running a real one, since the bug is purely about the
  state/reviewCache interaction, not the analyze pipeline itself): delete
  a project with a faked `state.lastAnalyzeResult` set, confirm
  `reviewCache[name]` is `null` immediately after, confirm it's STILL
  `null` after creating a new project with the identical name.

  **Bug 2 — OSC calibration frame previews looked wrong**: "the zoomed
  version looks right, but the thumbnail is way too bright," and for
  bias/dark specifically, neither thumbnail nor zoom matched what Siril's
  own unlinked autostretch shows (a mostly solid dark field with a small
  handful of hot/cold pixels). Two separate, real, previously-
  undiscovered bugs in `app/imaging.py`:
  1. **Thumbnail-vs-zoom inconsistency (affected all "calibration"-mode
     previews, most visible on flats)**: `ZScaleInterval`'s computed
     black/white points are an outlier-rejection statistic - they depend
     on a small handful of extreme pixels (dust motes, hot/cold pixels)
     surviving in the sample they're given. The old code computed these
     limits AFTER downsampling for the requested preview size - a
     thumbnail's heavy block-averaging stride smears each outlier's
     extreme value into its neighbors, diluting/erasing the very outliers
     ZScale needs, so a thumbnail and a full-res zoom of the exact SAME
     frame computed genuinely different stretches. Fixed: `render_preview_png()`
     now computes these limits ONCE on the full-resolution data, before
     any downsampling, and reuses them unchanged for whatever size
     actually gets rendered (`_apply_stretch()` gained an optional
     `limits` param for this). Verified against real master flat data:
     thumbnail and zoom now report identical mean/median brightness
     (157.3/159.0 both), where they previously would have differed.
  2. **Wrong stretch algorithm entirely for bias/dark**: `ZScaleInterval`
     (the existing "calibration" mode, correctly tuned for a FLAT's smooth
     vignetting gradient) targets the DS9/IRAF "sky background at a
     comfortable ~50% gray" display convention - confirmed by hand against
     real master bias/dark pixel data, this mapped the frame's own median
     to ~50% gray (washed out), not a dark field. A bias/dark frame is the
     opposite case from a flat: no gradient at all, just a near-uniform
     noise floor plus sparse hot/cold outliers - there's no "sky
     background" to show at a comfortable midtone. Added a NEW stretch
     mode, "noise" (`_mtf()`/`_autostretch_params()` in `app/imaging.py`),
     implementing the same midtones-transfer-function (MTF) autostretch
     PixInsight's ScreenTransferFunction and Siril's own "Auto Stretch"
     use - same documented defaults (0.25 target background, -2.8 MAD-
     based shadow clip) - which pushes the frame's own median down to a
     dark 0.25 via a nonlinear curve instead of ZScale's ~0.5. Master
     bias/dark previews (`renderMastersPreviews()` in `app.js`) now
     request `stretch=noise`; master flat keeps `stretch=calibration`
     (ZScale), unchanged. Also caught and fixed a THIRD contributing bug
     in the same investigation: bias/dark previews were being debayered
     whenever `is_osc`, exactly like flats - but a bias/dark frame is pure
     sensor noise, not light through a color filter array, so there's no
     real per-channel color to reconstruct, and bilinear debayering
     actively SPREADS each single hot/cold outlier pixel's extreme value
     across several of its neighbors (the interpolation kernel's own
     nature), further confusing any outlier-sensitive stretch. Master
     bias/dark previews now always render as the plain grayscale mosaic
     they actually are, regardless of `is_osc` (flats are unaffected -
     they still get debayered for a real color look). Verified against
     real master bias/dark data with the fix applied: median now lands at
     64/255 (≈0.25, matching the intended target) instead of ~127/255
     (≈0.5), consistent between thumbnail and zoom, with a small fraction
     of pixels (dark's real hot pixels) rendering distinctly bright -
     matching Chris's own description exactly. Confirmed live via CDP
     that the actual Masters step UI loads all three preview images
     successfully with the correct stretch/debayer parameters.
- ✅ **Debayer border color fringe fixed; version bumped to 0.5
  (2026-09-24)**. Chris caught one more issue right after the stretch
  fixes: zoomed-in debayered previews (unstacked lights and master flats)
  showed "a red/orange left/top border and a blue right/bottom border."
  Root cause, confirmed with a synthetic test before touching anything:
  `_convolve3x3()` (used by `_debayer_bilinear()`'s bilinear interpolation)
  padded its input with `mode="edge"` — but it's called on a SPARSE
  per-channel array (real R/B/G samples on a period-2 checkerboard, zeros
  everywhere else), and edge-replication duplicates whatever value (real
  sample or zero) happens to sit at the border with no regard for the
  checkerboard's phase. A synthetic uniform test image (R=100/G=150/B=200
  at every real sample, RGGB pattern) proved it exactly: the top-left
  corner came out with R spiking to 225 while B dropped to 50, and the
  bottom-right corner did the reverse (R down to 25, B up to 450) — an
  exact match for the reported symptom. Fixed by switching to
  `mode="reflect"` (mirrors WITHOUT repeating the edge value - pad[-1] =
  arr[1], not arr[0]), which always preserves a period-2 pattern's phase
  at any border or corner, so the padding is a plausible continuation of
  the real Bayer pattern instead of a phase-blind copy. Re-ran the exact
  same synthetic test after the fix: every single pixel, borders and
  corners included, now correctly comes out at the true uniform value
  (R=100, G=150, B=200 everywhere) with zero fringing. Also spot-checked
  against a real master flat preview post-fix to confirm no regressions
  (renders fine; real vignetting still visibly darkens the corners, which
  is correct/expected and unrelated to this bug).

  Version bumped `0.4` → `0.5` (`app/config.py`) - `0.4` was already set
  but never pushed/tagged (only `v0.3` exists in git so far - see
  `.github/workflows/docker-publish.yml`'s bump-by-hand convention), and
  this entire session's work (the full per-group darks redesign, three
  rounds of UI polish, the delete/review-cache bug, both stretch bugs, and
  this debayer fix) had all accumulated on top of that same unpushed `0.4`
  - bumping to `0.5` gives this whole batch its own version for whenever
  Chris pushes it. Still deliberately under 1.0, per the existing
  standing call (his own, not a checklist).
- ✅ **Real production usage round: a dozen fixes/features from Chris
  building an actual 3-night, 4-filter (H/L/O/S) mono project, plus a new
  cross-filter registration/alignment step (2026-09-25)**. Chris added
  real test data matching his production project
  (`NorthAmericaNebula-NGC7000/{2024-05-31,2024-06-12,2024-06-13}-
  NorthAmericaNebula-2600MM-Z61`, plus two DELIBERATELY unrelated OSC
  nights in the same parent folder to test that scanning doesn't pull
  them in) and his real master bias/dark libraries
  (`001-MasterBias/`, `002-MasterDarks/`, organized by camera/exposure).
  One root cause explained THREE of his reports at once:

  1. **Root cause (bugs "flats don't auto-fill," "darks don't auto-fill,"
     "exposure missing from picker info")**: `frameinfo.detect_exposure_
     seconds()`'s 90%-dominance rule returns `None` (ambiguous) for a
     lights folder mixing filters that genuinely use DIFFERENT exposures
     - confirmed on his real data: H/O/S all at 300s + L at 180s meant
     300s only covered 59/69 = 85.5% of the WHOLE folder, just under the
     threshold, even though each filter's own subset is 100% unambiguous.
     This silently broke `lightsDetectedExposureS` for every filter-locked
     row sharing that folder, which fed (a) the darks-mismatch warning,
     (b) darks cross-row auto-fill, and (c) the summary's exposure
     display - all three "broken" independently, actually one gap. Fixed
     with a new `frameinfo.detect_exposure_by_filter()` (per-filter
     dominant exposure, exposed as `/captures/browse`'s new
     `filter_exposures`) and a new per-row `effectiveLightsExposure()` in
     `app.js` that every consumer now reads instead of the raw ambiguous
     value. Verified live via CDP against the real data: H/O/S groups now
     correctly show "300s," L shows "180s"; darks auto-fill correctly
     propagates across H/O/S (300s) while correctly excluding L (180s);
     manually assigning a 300s dark to the 180s L group now correctly
     warns.
  2. **"Flats don't auto-fill on a second night"**: separately, splitting
     a mixed lights folder only ever had LIGHTS info at split time (flats
     usually isn't picked yet), so each of the resulting filter rows
     needed flats picked one at a time, once per filter, with no
     propagation - unlike the exposure-based darks auto-fill already
     built. New `autoFillMatchingFlats()`, matched by filter membership
     (not exposure) and deliberately scoped to rows sharing the EXACT SAME
     lights folder path (same physical night) - real mono data confirms
     why that scoping matters: each night has its own genuinely different
     flats (dust/vignetting, even each filter's own auto-exposure, change
     night to night), so night 2's H group must never inherit night 1's H
     flats just because both are filter "H." Verified live: picking flats
     on one of 4 split rows correctly fills the other 3 for that same
     night.
  3. **"Currently staged groups panel doesn't show/can't remove staged
     bias frames"**: new `DELETE /projects/{name}/biases` endpoint
     (mirrors the existing per-night delete) plus a biases row in
     `renderExistingStagedNights()`, gated on `biases_count > 0`. Verified
     end-to-end (stage biases, see it in the panel, delete it, confirm
     `biases_count` back to 0).
  4. **"Need a select-all button on Masters/Review/Stack checklists,
     especially with a 12+ group project"**: added "Select all"/"Select
     none" buttons to all three (`renderChecklist()`'s existing
     containers), each just mutating the shared `mastersSelected`/
     `analyzeSelected`/`stackSelected` Set then re-rendering that one
     checklist the normal way, so onChange/survivor-count/filter-mismatch
     side effects still fire correctly.
  5. **"Accept exclusions button per group, remove the main one at the
     top"**: removed the single global `#analyze-accept-recommended-btn`
     (which accepted every group's recommendations at once - too coarse
     for a 12-group project); each night-block in `renderAnalyzeOutput()`
     now gets its own button, shown only when that specific group has an
     unaccepted flagged frame.
  6. **Real bug: 4 genuinely corrupt (saturated/all-equal, effectively
     zero-variance) tail frames of a real session showed as "recommended
     accept" instead of flagged.** Root-caused precisely: the SERVER's
     `flag_anomalies()` (`app/framestats.py`) already had an unconditional
     `star_count == 0` rule and correctly computed `flagged=True` for
     these frames both before and after this fix (confirmed by literally
     running the OLD, unmodified code against the real bad frames AND a
     synthetic all-zero frame - both correctly returned `flagged=True`
     server-side). The REAL bug was client-side: `isFrameFlagged()`
     (`app.js`) recomputes flagging itself from raw z-scores against the
     adjustable outlier-sensitivity slider, but never checked
     `star_count === 0` directly - and a zero-star frame's OWN z-score
     isn't necessarily statistically extreme relative to a night that
     already had generally few detected stars (confirmed on the real
     frames: z-score of only 0.68, no other metric even computed since
     fwhm/roundness/snr are `None`-excluded for a star_count=0 frame) -
     confirmed the exact scenario with `state.lastAnomalySigma=3.0` before
     and after this specific fix via CDP. Fixed with a direct, ordering-
     independent check: `if (f.star_count === 0) return true;` up front,
     matching the server's own unconditional rule exactly. Also
     hardened `app/framestats.py` itself while investigating, even though
     it wasn't the root cause of THIS report: added `background`/
     `background_std` to `_FLAGGABLE_METRICS` (computed but never checked
     before - a real gap for a frame that's degenerate but not exactly
     star_count=0), and `analyze_frame()` now short-circuits before ever
     calling `IRAFStarFinder` on a zero-variance frame (a threshold of
     exactly 0 against already-zero data isn't a case it's designed for,
     even though it happened to behave predictably on this specific test
     data).
  7. **"Show all frames"/"Accept exclusions - show survivors only" popped
     open an image lightbox unexpectedly.** Root cause: `lightboxNav`
     (tracks which frame is currently shown) was never reset to `null` on
     EITHER lightbox-close path (overlay click, Escape key) - only ever
     reassigned by opening a NEW frame. The survivors toggle's own handler
     unconditionally does `if (lightboxNav) renderLightboxFrame()` to keep
     an OPEN lightbox in sync when the visible frame set changes - but
     with `lightboxNav` still truthy from an earlier, already-closed
     viewing, this popped the lightbox back open on every toggle click.
     Fixed by clearing `lightboxNav = null` in both close handlers.
  8. **New feature - final cross-filter registration/alignment step**:
     Chris: "the last step of a mono project should be a registration so
     that when they get combined during post processing they're
     aligned." New `app/ssf.py` function `render_register_finals()` +
     template `templates/register_finals.ssf.j2`: gathers every distinct
     filter's (or OSC exposure-group's) own FINAL stacked result
     (`final_stack_paths()`, covering both multi-night merges and
     single-night results, labeled via each night's own `night_filters`/
     `night_exposures` meta), symlinks them into one small N-frame
     sequence (named so Siril's own sequential numbering lands in a
     KNOWN, predictable alphabetical-by-label order - needed to map each
     aligned output back to its filter afterward), and runs Siril's
     `register` (global star alignment) on that sequence alone - no
     `stack` line after it, since `register` by itself already writes one
     aligned `r_final_NNNNN.fit` per input frame, which is exactly N
     pixel-aligned outputs, not one merged image. Reused the exact
     scratch/sibling-input-dir pattern already established for dark
     merging (the input dir is a SIBLING of the step's own `fresh_dir`,
     not nested under it, for the identical reason: nesting it would get
     wiped by `prepare_fresh_dirs()` right before the job runs).
     `SirilStep` gained a `moves: list[tuple[Path,Path]]` field alongside
     its existing singular `move`, since this step produces N outputs
     that each need their own destination (`process/lights/
     _aligned_finals/<label>.fit`) - `_run_steps()` in `main.py` now
     applies both. New endpoints `/register-finals/render`+`/run`; new
     `app/status.py` fields `final_results_count` (so the frontend knows
     whether to offer this at all) and `aligned_finals` (the list of
     already-aligned outputs, each downloadable). New Stack-step UI
     section, hidden until 2+ final results exist. **Verified completely
     end-to-end against 3 REAL stacked results already on disk (H/O/S from
     earlier session testing)**: the job succeeded, all three aligned
     outputs landed correctly labeled
     (`process/lights/_aligned_finals/{H,O,S}.fit`), and the job log
     confirms genuine star-based Global Star Alignment ran (2000 stars
     matched per image) with real, non-trivial computed corrections (dx
     up to 35px, small sub-degree rotations) - not a trivial no-op.
  9. **"We need a way to grab project logs through the webui... add some
     additional helpful logging"**: new `GET /projects/{name}/logs`
     (lists every `<job_id>.log` under `project/logs/`, surviving a
     server restart unlike the in-memory Job History list) and
     `GET /projects/{name}/logs/download` (zips them all up at once - the
     practical "send me the whole session's troubleshooting data in one
     click" ask). New "📄 Project logs" panel in the UI alongside the
     existing Job History button. Also added the requested extra
     logging: every job log now starts with a header naming the job id,
     kind, project, and steps (`app/jobs.py`'s new
     `_write_log_header()`) - previously a handed-over log file had none
     of that context baked in at all. Verified live: ran a real masters
     job, confirmed the header appears correctly before Siril's own
     output, confirmed the list+zip endpoints work against real project
     logs.
  10. Version bumped `0.5` → `0.6` (`app/config.py`).

  All fixes verified against the real NorthAmericaNebula data and/or real
  prior stacked results, not synthetic edge cases alone, per this
  session's established practice.
- ❌ **Crop is permanently out of scope**, not deferred — see Architecture
  decisions. Don't reopen this.
- ❌ Archive/cleanup (the Endstate's last bullet) is explicitly deferred
  per Chris (2026-09-20) — no design work done, intentionally.

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

**2026-09-20 update:** the Python implementation (`app/ssf.py`) now
diverges from this script in exactly one respect — lights convert into
their own disposable `process/lights/` workspace rather than directly
into `process/` alongside the masters — per gotcha #6 (a directory-wide
rescan bug that bites exactly the "review lights, exclude some, re-run"
workflow this tool exists to support). The *command sequence itself*
(convert → calibrate → register → stack, same flags) is unchanged and
still the reference; only where things land on disk changed. `test1`'s
original `process/result.fit` (this exact flat layout) still exists
untouched as the original manual validation.

**2026-09-2x follow-up:** the above single combined script is now further
split into several independent `siril-cli` invocations — one per master
type and one per night's calibrate step, plus one final register/stack —
per gotcha #8 (running multiple heavy sequence operations in one Siril
session is a severe, confirmed performance cliff). See
`render_build_masters()`/`render_stack_lights()` in `app/ssf.py` and
`jobs.create_multi_script_job()`. Again, the command sequence inside each
individual step is unchanged from this reference; only the process
boundaries and scratch-directory layout changed.

Notes for whoever templates this in Python (see gotcha #2/#3 above for why
the `raw/` staging layer exists at all — don't collapse it away):
- All four frame types convert into the same `process/` dir — matches the
  official Siril `OSC_Preprocessing.ssf` convention, not an invented layout.
  (Superseded for lights specifically by the 2026-09-20 update above.)
- `-cc=dark -cfa -equalize_cfa -debayer` on the light calibration line are
  OSC-specific (this camera is Bayer/RGGB). A mono-camera path would drop
  `-cfa`/`-equalize_cfa`/`-debayer`.
- The "few different stacking algorithms" knob Chris wants in the web UI
  is the `stack ... rej <type> <sigma_low> <sigma_high> ...` line's
  rejection type — see "Current validated status"'s stacking-methods
  entry (2026-09-22) for the three the UI actually exposes today.

## Immediate next steps
Everything from prior rounds is **done** — see "Current validated status"
for the full history, including CI + the UnRAID production deployment
(both confirmed working, 2026-09-2x), the initial seven-feature round
(output naming, stacking methods, root_dir, drizzle, header link,
project-creation redesign, exposure mismatch warning), and a same-day
follow-up round (integration-time format fix, the data-safety check
against Chris's real production project, per-night calibration
alignment replacing Stack's uniform master overrides, drizzle promoted
out of advanced options, and a user-facing text audit) — all verified
against Chris's reorganized real-layout test dataset. Crop is
permanently out of scope (Architecture decisions), not deferred.
Archive/cleanup is explicitly deferred per Chris, not started. **Format
note (Chris, 2026-09-2x): keep this list numbered going forward.**

**Nothing open right now.** One known, deliberate tradeoff worth
surfacing next time Chris is around calibration frames: a project's
`root_dir` speeds up picking that target's own lights/flats but doesn't
help navigate to shared calibration frames under
`000-CalibrationFrames/...`, since those live in a completely separate
part of the tree — see "Current validated status" item 3 above. Not
changed without Chris's say-so; a separate remembered "calibration
frames root" would be a reasonable follow-up if this friction turns out
to matter in practice.

**Incidental finding, not urgent**: while verifying the cross-project
state-leak fix, found that `live-test-3`/`-4`/`-5`/`-6`/`-7`/`live-test1`/
`live-test2` are now 100% broken symlinks (`/projects/{name}/broken-links`
confirms it for each) — stale test projects staged before Chris's
captures folder reorganization, pointing at paths that no longer exist.
`live-test-8` and `mono-test-1` are still valid. Purely leftover clutter
from earlier testing rounds, not a bug; worth a cleanup pass (delete via
the UI) whenever Chris wants to tidy the dev container, no rush.

The one future idea on the table (deleting an obviously-bad frame instead
of just excluding it) is real but deliberately **not** listed as a next
step — it needs an architecture decision first (`CAPTURES_DIR` is a
read-only mount) before it's buildable at all. See the "No more
file-management scope" bullet in Architecture decisions for the full
reasoning. Per-night master flat overrides were explicitly dropped by
Chris rather than built ("if I need to reuse flats, I can just do that
during staging and point multiple nights at the same set of flats").
When something new comes up, number it starting from 1 again.