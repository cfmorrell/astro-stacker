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
   frontend also has a job running, still can — a real gap, just a
   narrower one than "any double-click breaks it."
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

## Current validated status
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
  is the `stack ... rej 3 3 ...` line — swap `rej 3 3` for another Siril
  rejection method, that's the whole parameterization surface.

## Immediate next steps
Everything from the prior handoffs' lists is **done**: split masters/
lights phases, FastAPI render/run + background jobs, progress parsing,
real multi-night validation, a staging endpoint, frame review/filtering
(recommend-only, on astropy+photutils, with anomaly-based flagging
validated against real known-bad frames), both Siril gotcha #6/#8 fixes
in `/masters/run` and `/stack/run`, a first-version frontend, and five
further rounds of live-usage feedback/fixes on top of that (19 items,
then 18, then 8, then a stale-project-status bug plus whole-project
delete, then four more small fixes — see "Current validated status" for
the full list of what each round covered). Crop is permanently out of
scope (Architecture decisions), not deferred. Archive/cleanup is
explicitly deferred per Chris, not started. What's actually left:

1. **The frontend covers the full flow end-to-end now, but real gaps
   remain**: no way to *remove a single staged night* or re-stage over
   one that already exists from the UI (the API supports re-running
   `/stage`, the form just doesn't pre-fill from what's already there) —
   distinct from whole-*project* deletion, which now exists (`DELETE
   /projects/{name}` + the "Delete project" button); the folder browsers
   (`/captures/browse` and `/projects/{name}/browse`) have no breadcrumb
   trail, just an "← up" button; no polling/auto-refresh of project
   status while a job from *another* browser tab or the Swagger UI is
   running — combined with Frontend/web gotcha #4, two tabs running jobs
   against the same project at once can still 500; the exclude-frames
   list is global across nights in one request (matches the API's own
   semantics, see gotcha-adjacent note in `StackLightsRequest`, but worth
   a UI hint if it ever causes confusion); no way to browse job history
   (only the most recently started job's progress is shown per section,
   nothing persists across a page reload); the large-night collapsing
   behavior (flagged frames ± 2 neighbors, rest collapsed to an
   expandable "N more") is implemented but has never been exercised
   against a real >20-frame night, since no current test project has one
   — worth a specific look once real data that size exists; the debayer
   (`_debayer_block_mean`) is a quick-look 2x2-block demosaic, not a real
   (e.g. bilinear/AHD) one — fine for review, not for anything claiming
   photometric accuracy; the review lightbox's prev/next navigation
   (`app.js`'s `lightboxNav`) captures its frame list by reference at
   open time — if you toggle survivors-only or exclude the very frame
   you're looking at while the lightbox is open, the arrows keep
   navigating the list as it was when you opened it rather than the
   freshly-filtered one, a minor staleness edge case, not a crash. None
   of these are hard, just not done.
2. **No image thumbnails for the *stack* preview's intermediate steps** —
   only the raw lights (Review) and the final `result.fit` (Stack) get
   previews. A real "blink through everything" experience closer to the
   astropup-blink screenshot would also want previews of e.g. per-night
   master flats, for spotting a bad flat before it ruins a whole night's
   calibration.
3. **Per-night master overrides aren't wired up.** `master_dark`/
   `master_flat` on `StackLightsRequest` are single values applied
   uniformly to every requested night if given. That's correct for
   `master_dark` (genuinely shared — see the master reuse policy in
   Architecture decisions), but `master_flat` really wants a *per-night*
   override (e.g. "night3 is missing its own flats, reuse night2's" or a
   library entry) rather than one value forced onto every night in the
   request. Not built — flagged, not attempted; the frontend's Stack
   section now has a file picker for setting the override (see "Current
   validated status"), but it's still the same one global value applied
   to every selected night, not a per-night one.