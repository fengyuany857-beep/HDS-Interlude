#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p wheelhouse
python3 -m pip download --disable-pip-version-check --require-hashes -r requirements.lock -d wheelhouse
python3 -m pip download --disable-pip-version-check --require-hashes -r requirements-build.lock -d wheelhouse
docker build --pull=false -t "${HDSI_DISCORD_IMAGE:-hdsi-discord-user-sidecar:local}" .
