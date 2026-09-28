#!/bin/bash
# (Re)build and start the astro-stacker dev container on UnRAID. Run from the UnRAID console.
# Publishes 8083, which NPM proxies at astro-stacker-dev.cfmorrell.com (docs/DEPLOY.md) —
# reach it directly, no SSH tunnel needed.
#
# CPUSET_CPUS keeps Siril (which happily saturates every core it can see
# during a stack) off cores 0-5, reserved for the pihole VM — see
# Handoff.md's "pihole VM starved during a stack" gotcha. Cores 0-5 are the
# 3 physical P-cores at HT thread pairs (0,1)(2,3)(4,5); 6-19 is everything
# else (3 more P-cores fully + all 8 E-cores) — a clean split with no
# shared hyperthread siblings, confirmed via `lscpu -e` on this box's
# i5-14600K. Must match AstroStacker prod's own pinning (deploy/run.sh).
set -euo pipefail
BASE=/mnt/user/docker_appdata/astro-stacker
NAME=astro-stacker-dev
CPUSET_CPUS=${CPUSET_CPUS:-6-19}

docker build -t ${NAME} -f "$BASE/src/Dockerfile.dev" "$BASE/src"
docker rm -f ${NAME} >/dev/null 2>&1 || true
docker run -d --name ${NAME} --restart unless-stopped \
  --cpuset-cpus="$CPUSET_CPUS" \
  -v "$BASE/src":/app \
  -v /mnt/user/Astronomy/013-Astro-Stacker-Processing:/captures:ro \
  -v "$BASE/data":/data \
  -p 8083:8000 \
  ${NAME}
echo "Started: http://$(hostname):8083  (astro-stacker-dev.cfmorrell.com via NPM)"
echo "Shell in with:  docker exec -it ${NAME} bash"
