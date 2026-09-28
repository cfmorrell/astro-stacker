# Deploying on UnRAID

Two containers run side by side on the NAS (`FractalR5Tower`, 192.168.1.4):
a **dev** container (this repo bind-mounted, live-reload) and a **prod**
container (a published image, no bind mount). Both are repo-tracked so the
repo stays the source of truth instead of UnRAID's auto-generated templates.

**Both are pinned to `--cpuset-cpus=6-19`**, baked into `run-dev.sh` and
`deploy/run.sh` directly — Siril saturates every core it can see during a
stack, and cores 0-5 are reserved for a pihole VM on this box (see
Handoff.md's incident log). This is a hard requirement of *how these
containers are created*, not an UnRAID GUI setting: a container (re)created
by a raw `docker run` (which is what both scripts do) doesn't inherit
whatever pinning UnRAID's GUI has configured elsewhere — it only gets a
cpuset if the `docker run` command itself requests one. Override with
`CPUSET_CPUS=<range> ./run-dev.sh` (or `deploy/run.sh`) if the reserved
range ever needs to change — re-check `lscpu -e` first if the CPU itself
changes, to make sure the new range doesn't share hyperthread siblings with
whatever else is pinned.

## Dev — `astro-stacker-dev`

Built locally from `Dockerfile.dev`, source bind-mounted at `/app` so edits
on the host take effect immediately via `uvicorn --reload`. Started with
[`run-dev.sh`](../run-dev.sh):

```
/mnt/user/docker_appdata/astro-stacker/src/run-dev.sh
```

Mounts:

| Host path | Container path | Mode |
|---|---|---|
| `.../astro-stacker/src` (this repo) | `/app` | rw |
| `/mnt/user/Astronomy/013-Astro-Stacker-Processing` | `/captures` | ro |
| `.../astro-stacker/data` | `/data` | rw |

Publishes `8083 -> 8000`, `--restart unless-stopped`. NPM proxies
`astro-stacker-dev.cfmorrell.com` to `192.168.1.4:8083`, so the dev server
is reachable directly — no SSH tunnel needed. Re-run `run-dev.sh` any time
`Dockerfile.dev` changes (a rebuild is required for OS-level deps; app code
changes alone just need the bind mount, no rebuild).

For a shell alongside the running server (e.g. one-off scripts, checking
Siril CLI output): `docker exec -it astro-stacker-dev bash`, or the
`astro-stacker` SSH alias, which does the same thing.

## Production — `AstroStacker`

Pulls the published image from GHCR (built by
[`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml)
on every push to `main`), no bind mount — code changes require a new build.

**Template** (recommended): copy
[`deploy/unraid/astro-stacker.xml`](unraid/astro-stacker.xml) to
`/boot/config/plugins/dockerMan/templates-user/my-AstroStacker.xml`, then
Docker > Add Container > select the `AstroStacker` template.

**Or via script**: [`deploy/run.sh`](../deploy/run.sh), which supports
`IMAGE`/`PORT`/`DATA_DIR` overrides:

```
/mnt/user/docker_appdata/astro-stacker/src/deploy/run.sh
```

Mounts:

| Host path | Container path | Mode |
|---|---|---|
| `/mnt/user/Astronomy` | `/captures` | ro |
| `/mnt/user/docker_appdata/astrostacker/data` | `/data` | rw |

Publishes `8084 -> 8000`, `--restart unless-stopped`.

Update via GitHub package visibility being public (or a `docker login` to
GHCR on the box), then either UnRAID's Docker tab "Force update", or
`docker pull ghcr.io/cfmorrell/astro-stacker:latest && deploy/run.sh`.

## Moving between dev and prod

State doesn't carry over automatically — dev's `/data` and prod's `/data`
are separate directories (`astro-stacker/data` vs `astrostacker/data`,
historical naming drift, not worth reconciling). A project staged in one
isn't visible in the other.
