#!/usr/bin/env bash
# scripts/stage_captures.sh
# Symlinks raw calibration/light frames from a read-only capture
# directory into a writable staging tree, since Siril's own `cd`
# requires its target to be writable (see project notes).
set -euo pipefail

CAPTURES_DIR="$1"   # e.g. /captures
PROJECT_DIR="$2"    # e.g. /data/projects/test1

for kind in lights darks flats biases; do
    mkdir -p "$PROJECT_DIR/raw/$kind"
    if compgen -G "$CAPTURES_DIR/$kind"/*.fit > /dev/null; then
        ln -sf "$CAPTURES_DIR/$kind"/*.fit "$PROJECT_DIR/raw/$kind/"
    fi
done