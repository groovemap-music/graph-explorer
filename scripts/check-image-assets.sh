#!/usr/bin/env bash
# Extract the served static tree from a built image (no container is started) and
# verify its brand assets against the provenance record.
set -euo pipefail
image="${1:-${IMAGE_TAG:-graph-explorer:local}}"
static_path="${STATIC_PATH:-/app/.venv/lib/python3.14/site-packages/explore/static}"
workdir="$(mktemp -d)"
container=""
cleanup() {
  if [[ -n "${container}" ]]; then docker rm --force "${container}" >/dev/null; fi
  rm -rf "${workdir}"
}
trap cleanup EXIT
container="$(docker create "${image}")"
docker cp "${container}:${static_path}/brand" "${workdir}/brand"
uv run python scripts/check-brand.py --static-dir "${workdir}"
