#!/bin/bash
# Run the published astro-stacker image on UnRAID without the template (docs/DEPLOY.md). Run from the UnRAID console.
set -euo pipefail
NAME=AstroStacker
IMAGE=${IMAGE:-ghcr.io/cfmorrell/astro-stacker:latest}
PORT=${PORT:-8084}
DATA_DIR=${DATA_DIR:-/mnt/user/docker_appdata/astrostacker/data}

mkdir -p "$DATA_DIR"
docker pull "$IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -v /mnt/user/Astronomy:/captures:ro \
  -v "$DATA_DIR":/data \
  -p "$PORT":8000 \
  "$IMAGE"
echo "Started: http://$(hostname):$PORT"
