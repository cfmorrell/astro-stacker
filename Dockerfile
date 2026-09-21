# syntax=docker/dockerfile:1
#
# Production image: Python + Siril CLI + FastAPI (app/), self-contained.
# Unlike Dockerfile.dev (bind-mounted /app, `uvicorn --reload`, long-lived
# `docker exec` workflow), this COPIES the app code into the image and runs
# uvicorn directly with no reload — a new build is required to pick up code
# changes, which is the point for something meant to run unattended.
#
# Build:
#   docker build -t astro-stacker .
#
# Run (bind-mount only the two data directories, not the app code):
#   docker run -d --name astro-stacker \
#     -v /mnt/user/Astronomy/013-Astro-Stacker-Processing:/captures:ro \
#     -v /mnt/user/docker_appdata/astro-stacker/data:/data \
#     -p 8000:8000 \
#     astro-stacker
#
# SIRIL_BIN/DATA_DIR/CAPTURES_DIR all have the right defaults baked in
# (see app/config.py) - only override them if the container's mount paths
# ever need to differ from /data and /captures.

FROM debian:bookworm-slim

RUN apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
        curl unzip ca-certificates squashfs-tools binutils \
        python3 python3-pip python3-venv \
        libgsl27 libfftw3-double3 libfftw3-single3 libgomp1 libexiv2-27 \
        libheif1 libraw20 libwcs7 libglib2.0-0 libgl1 libxrender1 libxext6 \
        libxft2 libfontconfig1 libsm6 libcurl4 libcfitsio10 libopencv-core406 \
    && rm -rf /var/lib/apt/lists/*

# --- Siril 1.4 AppImage, extracted without FUSE ------------------------------
# Same trick astrolab's own Dockerfile uses: unsquashfs the AppImage's
# embedded squashfs directly instead of running the ELF stub, which avoids
# needing FUSE inside the container entirely.
ARG SIRIL_VERSION=1.4.3
ARG SIRIL_URL=https://free-astro.org/download/Siril-1.4.3-x86_64.AppImage

WORKDIR /fetch
RUN curl -fL --progress-bar -o Siril.AppImage "$SIRIL_URL" && \
    printf '%s\n' \
      'import struct' \
      'f = open("Siril.AppImage","rb")' \
      'f.seek(40); shoff = struct.unpack("<Q", f.read(8))[0]' \
      'f.seek(58); shentsize, shnum = struct.unpack("<HH", f.read(4))' \
      'print(shoff + shentsize * shnum)' \
      > offset.py && \
    OFFSET=$(python3 offset.py) && \
    echo "squashfs offset: $OFFSET bytes" && \
    unsquashfs -offset "$OFFSET" -d /opt/siril Siril.AppImage && \
    rm -rf /fetch

# AppRun is the AppImage's own launcher/dispatcher; it works for both the
# GUI and CLI entry points. If invoking it directly ever misbehaves, look
# for the CLI binary explicitly at /opt/siril/usr/bin/siril-cli instead.
ENV SIRIL_BIN=/opt/siril/AppRun \
    PATH="/opt/siril/usr/bin:${PATH}" \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

COPY app/ app/
COPY static/ static/
COPY templates/ templates/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
