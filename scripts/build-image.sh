#!/usr/bin/env bash
set -euo pipefail
docker_config="$(mktemp -d)"
trap 'rm -rf "${docker_config}"' EXIT
active_context="$(docker context ls --format '{{if .Current}}{{.Name}}{{end}}' | sed -n '1p')"
docker_host="$(docker context inspect "${active_context}" --format '{{.Endpoints.docker.Host}}')"
vcs_ref="$(git rev-parse HEAD)"
build_version="$(python -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')"
build_date="$(git show -s --format=%cI HEAD)"
[[ "${vcs_ref}" =~ ^[0-9a-f]{40}$ ]]
DOCKER_HOST="${docker_host}" docker --config "${docker_config}" build \
  --build-arg "BUILD_DATE=${build_date}" \
  --build-arg "BUILD_VERSION=${build_version}" \
  --build-arg "VCS_REF=${vcs_ref}" \
  --tag graph-explorer:local .
test "$(DOCKER_HOST="${docker_host}" docker --config "${docker_config}" image inspect graph-explorer:local --format '{{index .Config.Labels "org.opencontainers.image.licenses"}}')" = "AGPL-3.0-only"
test "$(DOCKER_HOST="${docker_host}" docker --config "${docker_config}" image inspect graph-explorer:local --format '{{index .Config.Labels "org.opencontainers.image.source"}}')" = "https://github.com/groovemap-music/graph-explorer"
test "$(DOCKER_HOST="${docker_host}" docker --config "${docker_config}" image inspect graph-explorer:local --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "${vcs_ref}"
DOCKER_HOST="${docker_host}" docker --config "${docker_config}" run --rm \
  --entrypoint /app/.venv/bin/python graph-explorer:local \
  -c 'from importlib.resources import files; root = files("explore").joinpath("static"); vendor = root.joinpath("vendor"); assert vendor.joinpath("THIRD_PARTY_NOTICES.md").is_file(); assert vendor.joinpath("ASSET_LICENSES.json").is_file(); assert len(tuple(vendor.joinpath("licenses").iterdir())) == 10; assert root.joinpath("brand/source.json").is_file()'
DOCKER_HOST="${docker_host}" docker --config "${docker_config}" run --rm \
  --entrypoint /bin/sh graph-explorer:local \
  -c 'test -s /usr/share/doc/graph-explorer/LICENSE && test -s /usr/share/doc/graph-explorer/NOTICE && test -s /usr/share/doc/graph-explorer/COMMERCIAL-LICENSING.md && test -s /usr/share/doc/graph-explorer/BRAND-NOTICE.md'
