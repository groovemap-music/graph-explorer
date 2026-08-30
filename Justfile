set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

setup:
    uv sync --dev --frozen
    npm --prefix explore ci --ignore-scripts

source-check:
    uvx --from ruff==0.16.4 ruff format --check .
    uvx --from ruff==0.16.4 ruff check .
    python scripts/check-contracts.py
    python scripts/check-brand.py
    python scripts/check-repository-compliance.py
    npm --prefix explore ci --ignore-scripts
    npm --prefix explore run build:web
    node explore/scripts/vendor-licenses.mjs check
    npm --prefix explore test
    test -s explore/static/tailwind.css

security:
    gitleaks git --redact --no-banner
    gitleaks dir . --redact --no-banner

check: source-check security typecheck test build artifact-check install-check license-check release-artifacts bump-preview

format:
    uv run ruff format .
    uv run ruff check --fix .

typecheck:
    uv run mypy

test:
    uv run pytest -m 'not e2e' --cov=explore --cov-report=term-missing --cov-report=xml

js-test:
    npm --prefix explore test

coverage: test
    npm --prefix explore run test:coverage

e2e-setup:
    uv run playwright install chromium firefox webkit

e2e-instrument: web-build
    bash scripts/instrument-e2e-coverage.sh

e2e-run:
    bash scripts/run-e2e-matrix.sh

e2e-post:
    node explore/scripts/finalize-e2e-coverage.mjs

e2e: web-build
    bash scripts/e2e-with-coverage.sh

web-build:
    npm --prefix explore ci --ignore-scripts
    npm --prefix explore run build:web
    test -s explore/static/tailwind.css

build: web-build
    uv build --out-dir dist --clear

artifact-check:
    python scripts/check-vendor-artifacts.py dist/*.whl

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
    python scripts/check-brand.py

brand-promote:
    bash scripts/promote-brand.sh

image: prepare-runtime-wheel
    bash scripts/build-image.sh
    docker run --rm --entrypoint /app/.venv/bin/python graph-explorer:local -c 'import explore.explore'
    test "$(docker run --rm --entrypoint /usr/bin/id graph-explorer:local -u):$(docker run --rm --entrypoint /usr/bin/id graph-explorer:local -g)" = "1000:1000"

bump-preview:
    uv run cz bump --dry-run --changelog --yes --check-consistency

# Update local version metadata and changelog only; do not commit, tag, push, or publish.
bump:
    uv run cz bump --version-files-only --changelog --yes --check-consistency
    uv lock

release-artifacts: build install-check
    bash scripts/release-dry-run.sh

release-dry-run: check

history-rehearsal source-repository output-directory:
    PLANNING_ARCHIVE_REPO="${PLANNING_ARCHIVE_REPO}" bash scripts/rehearse-history-sanitization.sh "{{source-repository}}" "{{output-directory}}"
