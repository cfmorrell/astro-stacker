# astro-stacker

A self-hosted web app that wraps [Siril](https://siril.org/) for astrophotography calibration, registration, and
stacking. It runs in a Docker container on a NAS, points at a night (or several) of light frames plus your
darks/flats/biases, and — with a human reviewing frame quality along the way — hands back a single stacked `.fit`
file per filter (or exposure group, for OSC). It runs on UnRAID.

It deliberately stops there: stretching, color work, and star removal all happen in other software. Getting frames
onto the NAS in the first place is a separate app's job too — [astro-ingest](https://github.com/cfmorrell/astro-ingest),
whose look this one shares.

## How a project goes

The app walks through four steps, with a step bar and a **Refresh status** button that always reflect what's
actually on disk — reloading the page or switching projects never loses your place.

1. **Stage** symlinks raw frames from a read-only captures directory into the project, one **group** at a time (a
   group is a night, or a filter, or both — whatever your source folders actually separate). Point a group at its
   lights and flats folders and the app auto-detects filters and exposure lengths, splitting one folder that mixes
   several into one row per filter/exposure automatically. Darks are picked per group, not once for the whole
   project — different filters or exposure lengths often need their own — but groups that land on the same exposure
   length automatically share one built master, so picking darks per group never means extra builds. Auto-populate
   can also scan a project's root folder and propose groups and calibration frames from what it finds there, ready
   to review before staging. A broken-links check runs quietly in the background and flags any staged symlink whose
   source frame has since moved or been deleted outside the app.
2. **Masters** builds one shared master bias for the whole project, plus a master dark and master flat per group
   (deduplicated by exposure length, so two groups needing the same dark only build it once). The calibration
   alignment panel lets a group borrow a different dark or flat than its own if it doesn't have one.
3. **Review** measures every staged light frame — FWHM, roundness, star count, SNR, sky background — and flags
   outliers by an adjustable sigma threshold, purely as a recommendation: nothing is excluded from the stack until
   you check it off, in the grid or in the full-size lightbox. Flagging updates instantly as you move the
   sensitivity slider, with no re-analysis needed.
4. **Stack** calibrates, registers, and stacks the surviving lights into one final `.fit` per group you select
   (sigma rejection, winsorized sigma, or mean; optional drizzle). For a multi-filter project, a final step —
   **align final results** — registers every group's own finished stack against every other one, so they come out
   pixel-aligned for combining as channels later in something like PixInsight.

Every long-running step (masters, stack, review analysis, final-result alignment) runs as a background job with
live progress; the **active jobs** panel at the top tracks every project's running jobs at once, so a stack running
in one project stays visible while you're staged into a different one. **Job history** covers jobs since the server
last restarted; **Project logs** keeps every job's full log on disk, downloadable individually or all together as a
`.zip`, for troubleshooting after the fact.

## Safety

- `CAPTURES_DIR` is always mounted read-only and the app only ever symlinks from it — raw frames are never moved,
  copied, or modified.
- Everything the app writes (staged symlinks, masters, stacked results) lives under a project's own directory in
  `DATA_DIR`. Deleting a project, a group, or a shared bias only ever removes within that project's own working
  directory.
- A frame excluded in Review is never silently dropped elsewhere — the same exclude list applies across every group
  a Stack run touches, and it's shown back to you on the Stack panel before you run it.

## Install on UnRAID

The image is built by GitHub Actions on every push to `main` and published as **`ghcr.io/cfmorrell/astro-stacker`**
(`latest`, plus `sha-`/`v`-tagged builds). Install it from the UnRAID template in
[`deploy/unraid/`](deploy/unraid/) or with [`deploy/run.sh`](deploy/run.sh); full mount tables and both the
production and dev container setups are in [`docs/DEPLOY.md`](docs/DEPLOY.md).

| Container path | Default host path | What |
|---|---|---|
| `/captures` (**read-only**) | `/mnt/user/Astronomy` | Raw light/dark/flat/bias frames. |
| `/data` | `/mnt/user/docker_appdata/astrostacker/data` | Per-project working directories: staged symlinks, masters, stacked results. |
| `8000` | `8084` | The web app. |

No required environment variables — `SIRIL_BIN`/`DATA_DIR`/`CAPTURES_DIR` all default to the paths above already
baked into the image; only override them if a container's mount paths ever need to differ.

## Development

A long-lived dev container on UnRAID (`astro-stacker-dev`) holds the repo bind-mounted at `/app` and runs
`uvicorn --reload`, so edits on the host take effect immediately with no rebuild. It's self-starting and reachable
directly — no SSH tunnel needed — via `astro-stacker-dev.cfmorrell.com`, proxied by NPM to its published port.
Rebuild/recreate it (needed only for `Dockerfile.dev`-level changes, e.g. new OS packages) with
[`run-dev.sh`](run-dev.sh) at the repo root; for a shell alongside the running server, `docker exec -it
astro-stacker-dev bash` (or the `astro-stacker` SSH alias, which does the same thing).

- Plain FastAPI + a static vanilla-JS page (no build step, no framework) shelling out to `siril-cli` via
  Jinja2-templated `.ssf` scripts (see [`templates/`](templates/)), with a small in-memory job manager for the
  long-running masters/stack/analyze/register-finals jobs. Frame-info parsing, staging, script rendering, and
  status all live in their own modules under [`app/`](app/) — see [`Handoff.md`](Handoff.md) for the full
  architecture history and every gotcha discovered building this against real Siril behavior.
- No automated test suite yet — verification has been manual, against real capture sets, via the running dev
  container.
- The version is in `app/config.py` (shown in the header and `/health`). It goes up by hand with each round of
  changes and stays under 1.0 until the app has been run in production long enough to trust it.
