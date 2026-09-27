#!/bin/bash
# (Re)build and start the astro-stacker dev container on UnRAID. Run from the UnRAID console.
# Publishes 8083, which NPM proxies at astro-stacker-dev.cfmorrell.com (docs/DEPLOY.md) —
# reach it directly, no SSH tunnel needed.
set -euo pipefail
BASE=/mnt/user/docker_appdata/astro-stacker
NAME=astro-stacker-dev

docker build -t ${NAME} -f "$BASE/src/Dockerfile.dev" "$BASE/src"
docker rm -f ${NAME} >/dev/null 2>&1 || true
docker run -d --name ${NAME} --restart unless-stopped \
  -v "$BASE/src":/app \
  -v /mnt/user/Astronomy/013-Astro-Stacker-Processing:/captures:ro \
  -v "$BASE/data":/data \
  -p 8083:8000 \
  ${NAME}
echo "Started: http://$(hostname):8083  (astro-stacker-dev.cfmorrell.com via NPM)"
echo "Shell in with:  docker exec -it ${NAME} bash"
