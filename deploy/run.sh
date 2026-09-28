#!/bin/bash
# Run the published astro-stacker image on UnRAID without the template (docs/DEPLOY.md). Run from the UnRAID console.
set -euo pipefail
NAME=AstroStacker
IMAGE=${IMAGE:-ghcr.io/cfmorrell/astro-stacker:latest}
PORT=${PORT:-8084}
DATA_DIR=${DATA_DIR:-/mnt/user/docker_appdata/astrostacker/data}
# Keeps Siril off cores 0-5 (reserved for the pihole VM) during a stack —
# see run-dev.sh for why this exact range and Handoff.md's "pihole VM
# starved during a stack" gotcha. Must match run-dev.sh's own pinning.
CPUSET_CPUS=${CPUSET_CPUS:-6-19}

mkdir -p "$DATA_DIR"
docker pull "$IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --cpuset-cpus="$CPUSET_CPUS" \
  -v /mnt/user/Astronomy:/captures:ro \
  -v "$DATA_DIR":/data \
  -p "$PORT":8000 \
  "$IMAGE"
echo "Started: http://$(hostname):$PORT"
