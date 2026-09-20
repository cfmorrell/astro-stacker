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
- **astropup-blink** (`astropup.app/#app-blink`, mentioned by Chris as the
  UX reference for frame review) — its actual page content wasn't
  fetchable when researched (2026-09-20; the page appears to be a
  JS-rendered SPA that returned nothing to a plain fetch). `/lights/analyze`
  was designed from Siril's own native capabilities plus Chris's explicit
  requirement ("recommendations, not automatic filtering") rather than
  from a real look at astropup-blink's UI — worth an actual look
  (screenshot/manual walkthrough) before building any UI on top of this,
  in case its specific presentation (e.g. how it visualizes outliers) is
  worth matching more closely than a guess got us.
- **Siril's `.seq` registration-data format** (undocumented anywhere
  found — reverse-engineered from real output): after `register`, a `R<layer>`
  line per frame holds `fwhm wfwhm roundness quality background nb_stars`,
  in that column order — confirmed by matching 1:1 against `seqapplyreg`'s
  documented filter flags (`-filter-fwhm/-filter-wfwhm/-filter-round/
  -filter-quality/-filter-bkg/-filter-nbstars`). `quality` has read `0` for
  every frame tested so far (deep-sky Global Star Alignment doesn't seem
  to populate it). Parsed by `app/seqstats.py`; see its module docstring.

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
   which must never be wiped. **`/masters/run` has this same latent risk
   and does not yet have the fix** — it still converts straight into the
   shared `process/`(`/nights/<name>`) dir with no cleanup, so re-running
   it a second time against a *different* frame count in `raw/biases`
   `raw/darks`, or a night's `raw/.../flats` is unverified and should be
   assumed unsafe until it gets the same treatment.
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
  (render + run), calibrating and registering each night's lights
  *independently* (no stacking, no merge) purely to harvest Siril's own
  per-frame FWHM/weighted-FWHM/roundness (the eccentricity proxy Chris
  asked for)/background/star-count from the resulting `.seq` file
  (`app/seqstats.py`, format reverse-engineered — see Reference material).
  Validated for real against the two-night data: real per-frame numbers,
  correctly correlated back to original filenames. **Recommends, never
  auto-filters**, per Chris's explicit direction — nothing is excluded
  unless a human passes `exclude_frames` to `/stack/run` or
  `/lights/analyze/run` afterward (`LightSelection`/
  `apply_light_selections()` stage a filtered symlink copy of just the
  kept frames; the excluded ones are never touched, moved, or deleted).
  astropup-blink itself wasn't actually inspectable when researched (see
  Reference material) — this was designed from Siril's native output plus
  Chris's stated requirement, not from a real look at that app's UI.
- ✅ **Fixed a real staleness bug found while validating the above**
  (gotcha #6): light conversion/registration/stacking now happens in a
  disposable per-run workspace, wiped clean before every run
  (`prepare_fresh_dirs()`), separate from wherever that scope's master
  files live. Verified by running `/lights/analyze/run` twice in a row
  against the same night with two *different* `exclude_frames` sets and
  confirming the second run's result reflected only the second run's
  input, with zero bleed-through from the first.
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
- ❌ `/masters/run` does **not** have the gotcha #6 fix yet — re-running it
  against a changed frame count in `raw/biases`/`raw/darks`/a night's
  `raw/.../flats` is unverified and should be assumed unsafe (see gotcha
  #6's note) until it gets the same disposable-workspace treatment.
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
Everything from the prior handoff's list is **done** — split masters/
lights phases, FastAPI render/run + background jobs, progress parsing,
real multi-night validation, a staging endpoint, and frame review/
filtering (recommend-only) — see "Current validated status" above. Crop
is permanently out of scope (Architecture decisions), not deferred.
Archive/cleanup is explicitly deferred per Chris, not started. What's
actually next:

1. **Give `/masters/run` the gotcha #6 fix** (disposable workspace,
   wiped before each run) that `/stack/run` and `/lights/analyze/run`
   already have. Currently the only piece of the pipeline still writing
   straight into a persistent directory with no cleanup — low risk in the
   common "build once" workflow, but unverified and should be fixed
   before anyone relies on rebuilding masters repeatedly.
2. **No UI consumes any of this yet** — `/docs` (Swagger) is the only way
   to drive it today. The natural next slice is a real frontend: stage a
   project, kick off masters/stack jobs and watch `percent_complete`/
   `current_command`, and — the interesting part — a `/lights/analyze`
   review screen (thumbnails or a plot of FWHM/roundness/background per
   frame, letting a human pick `exclude_frames` before stacking). Take an
   actual look at astropup-blink's UI before building this — it wasn't
   inspectable when researched this round (see Reference material) and
   might have a specific presentation worth matching.
3. `master_flat`/`master_dark` overrides in `StackLightsRequest` currently
   apply uniformly to *all* nights if given (see `LightsSelectionRequest`
   docstring) — fine for now, but if a real workflow needs a *per-night*
   override too (e.g. reusing one specific night's master library entry),
   that's not wired up.
4. Frame-review numbers (FWHM/roundness/background/star-count) are
   returned raw with no computed "this one looks off" flag — Chris asked
   for recommendations, and right now a human has to eyeball the numbers
   themselves. A simple z-score-per-metric flag (still purely advisory,
   never auto-excluding) would close that gap without contradicting the
   recommend-don't-filter decision.