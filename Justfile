set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

setup:
    uv sync --dev --frozen
    npm --prefix explore ci --ignore-scripts

source-check:
    uv run ruff format --check .
    uv run ruff check .
    uv run python scripts/check-contracts.py
    uv run python scripts/check-brand.py --design-repo "${GROOVEMAP_DESIGN_REPO:-../design}" --fetch
    uv run python scripts/check-repository-compliance.py
    uv run python scripts/check-docs.py

secret-scan:
    gitleaks git --redact --no-banner
    gitleaks dir . --redact --no-banner

check: source-check secret-scan typecheck test js-test build artifact-check install-check license-check release-artifacts bump-preview

format:
    uv run ruff format .
    uv run ruff check --fix .

typecheck:
    uv run mypy

test:
    uv run pytest -m 'not e2e and not benchmark and not image' --cov=explore --cov-report=term-missing --cov-report=xml

js-test: web-dependencies
    npm --prefix explore test

coverage: test web-dependencies
    npm --prefix explore run test:coverage

e2e-setup:
    uv run playwright install --with-deps chromium firefox webkit

e2e-instrument: web-build
    bash scripts/instrument-e2e-coverage.sh

e2e-run:
    bash scripts/run-e2e-matrix.sh

e2e-post:
    node explore/scripts/finalize-e2e-coverage.mjs

e2e: web-build
    bash scripts/e2e-with-coverage.sh

# Strata renderer frame time on a 20,000-node synthetic layout (docs/strata-renderer.md).
# Set STRATA_PERF_HEADED=1 to measure on the real GPU in a headed browser.
strata-perf: web-build
    uv run pytest -m benchmark -s tests/perf

web-build: web-dependencies
    npm --prefix explore run build:web
    node explore/scripts/vendor-licenses.mjs check
    test -s explore/static/tailwind.css

[private]
web-dependencies:
    npm --prefix explore ci --ignore-scripts

build: web-build
    uv build --out-dir dist --clear

artifact-check: build
    uv run python scripts/check-vendor-artifacts.py dist/*.whl

install-check: build
    bash scripts/install-check.sh

license-check:
    uv run python scripts/check-license.py
    uv run pip-licenses --ignore-packages groovemap-graph-explorer groovemap-runtime --fail-on "GPL-2.0-only;GPL-3.0-only;AGPL-3.0-only"

audit:
    uv run pip-audit
    npm --prefix explore audit --audit-level=high

prepare-runtime-wheel:
    bash scripts/prepare-runtime-wheel.sh

brand:
    uv run python scripts/check-brand.py

# Check the record against the design repo at the pinned commit (local checkout if it has the commit, else a read-only fetch).
brand-provenance:
    uv run python scripts/check-brand.py --design-repo "${GROOVEMAP_DESIGN_REPO:-../design}" --fetch

# Check the brand assets served by a built image without running it.
image-assets-check:
    bash scripts/check-image-assets.sh "${IMAGE_TAG:-graph-explorer:local}"

brand-promote:
    bash scripts/promote-brand.sh

image: prepare-runtime-wheel
    bash scripts/build-image.sh
    docker run --rm --entrypoint /app/.venv/bin/python "${IMAGE_TAG:-graph-explorer:local}" -c 'import explore.explore'
    test "$(docker run --rm --entrypoint /usr/bin/id "${IMAGE_TAG:-graph-explorer:local}" -u):$(docker run --rm --entrypoint /usr/bin/id "${IMAGE_TAG:-graph-explorer:local}" -g)" = "1000:1000"
    just image-assets-check
    just image-deps-check
    just image-deps-check-negative
    just image-themes

# Inside the built image: installed distributions must match uv.lock and `pip check` must be clean.
image-deps-check:
    docker run --rm --entrypoint /app/.venv/bin/python "${IMAGE_TAG:-graph-explorer:local}" /usr/share/graph-explorer/check-image-deps.py

# Negative proof: the same check must fail against a lock that disagrees with the built image.
image-deps-check-negative:
    #!/usr/bin/env bash
    set -euo pipefail
    image="${IMAGE_TAG:-graph-explorer:local}"
    docker run --rm --entrypoint /bin/cat "${image}" /usr/share/graph-explorer/runtime-requirements.txt \
      | sed "s/^fastapi==.*/fastapi==0.141.1/" \
      | if docker run --rm -i --entrypoint /app/.venv/bin/python "${image}" \
          /usr/share/graph-explorer/check-image-deps.py --lock -; then
          echo "image-deps-check accepted a mismatched lock" >&2
          exit 1
        fi

# Real-browser check of the built image: canonical brass/oxblood tokens in light and dark, and none of
# the previous-theme (Deep Space, Lagoon, Mint) values. Screenshots land in test-results/image-themes/.
image-themes:
    uv run playwright install ${CI:+--with-deps} chromium
    GRAPH_EXPLORER_IMAGE="${IMAGE_TAG:-graph-explorer:local}" uv run pytest -m image tests/image -p no:cacheprovider

# Negative proof: the same assertions must fail against the published v0.2.2 image, which still served
# the Deep Space (navy/cyan) theme. Override PUBLISHED_IMAGE to pin a digest; the published tags are linux/amd64 (PUBLISHED_PLATFORM).
image-themes-negative:
    #!/usr/bin/env bash
    set -euo pipefail
    published="${PUBLISHED_IMAGE:-ghcr.io/groovemap-music/graph-explorer:v0.2.2}"
    uv run playwright install ${CI:+--with-deps} chromium
    platform="${PUBLISHED_PLATFORM:-linux/amd64}"
    docker pull --platform "${platform}" "${published}"
    if GRAPH_EXPLORER_IMAGE="${published}" GRAPH_EXPLORER_PLATFORM="${platform}" uv run pytest -m image tests/image -p no:cacheprovider; then
      echo "image theme check accepted ${published}, which carries the old theme" >&2
      exit 1
    fi

bump-preview:
    uv run python scripts/check_bump_preview.py

# Update local version metadata and changelog only; do not commit, tag, push, or publish.
bump:
    uv run cz bump --version-files-only --changelog --yes --check-consistency
    npm --prefix explore version "$(uv run cz version --project)" --no-git-tag-version
    uv lock

release-artifacts: build install-check
    bash scripts/release-dry-run.sh --reuse-packages

release-dry-run: check

history-rehearsal source-repository output-directory:
    PLANNING_ARCHIVE_REPO="${PLANNING_ARCHIVE_REPO}" bash scripts/rehearse-history-sanitization.sh "{{source-repository}}" "{{output-directory}}"
