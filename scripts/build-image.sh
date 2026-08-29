#!/usr/bin/env bash
set -euo pipefail
docker_config="$(mktemp -d)"
trap 'rm -rf "${docker_config}"' EXIT
active_context="$(docker context ls --format '{{if .Current}}{{.Name}}{{end}}' | sed -n '1p')"
docker_host="$(docker context inspect "${active_context}" --format '{{.Endpoints.docker.Host}}')"
DOCKER_HOST="${docker_host}" docker --config "${docker_config}" build --tag graph-explorer:local .
DOCKER_HOST="${docker_host}" docker --config "${docker_config}" run --rm \
  --entrypoint /app/.venv/bin/python graph-explorer:local \
  -c 'from importlib.resources import files; vendor = files("explore").joinpath("static/vendor"); assert vendor.joinpath("THIRD_PARTY_NOTICES.md").is_file(); assert vendor.joinpath("ASSET_LICENSES.json").is_file(); assert len(tuple(vendor.joinpath("licenses").iterdir())) == 10'
