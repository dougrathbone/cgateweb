#!/usr/bin/env bash
# Assemble the add-on image build context that both CI smoke builds and the
# release publish path use. Keep this script as the single recipe so the two
# workflows cannot drift.
set -euo pipefail

DEST="${1:-ctx}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "${DEST}"
cp -r "${ROOT}/homeassistant-addon/rootfs" "${DEST}/"
cp "${ROOT}/homeassistant-addon/run.sh" "${DEST}/"
cp "${ROOT}/homeassistant-addon/Dockerfile" "${DEST}/"
cp -r "${ROOT}/src" "${ROOT}/public" "${DEST}/"
cp "${ROOT}/index.js" "${ROOT}/package.json" "${ROOT}/package-lock.json" "${DEST}/"
