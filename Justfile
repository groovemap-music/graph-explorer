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
    npm --prefix explore ci --ignore-scripts
    npm --prefix explore run build:web
    npm --prefix explore test
    test -s explore/static/tailwind.css
    gitleaks git --redact --no-banner
    gitleaks dir . --redact --no-banner

check: source-check typecheck test build install-check license-check bump-preview

format:
    uv run ruff format .
    uv run ruff check --fix .

typecheck:
    uv run mypy

test:
    uv run pytest -m 'not e2e' --cov=explore --cov-report=term-missing

js-test:
    npm --prefix explore test

e2e-setup:
    uv run playwright install chromium

e2e:
    uv run pytest -m e2e --browser chromium

web-build:
    npm --prefix explore ci --ignore-scripts
    npm --prefix explore run build:web
    test -s explore/static/tailwind.css

build: web-build
    uv build --out-dir dist --clear

install-check: build
    bash scripts/install-check.sh

license-check:
    uv run python scripts/check-license.py
    uv run pip-licenses --fail-on "GPL-2.0-only;GPL-3.0-only;AGPL-3.0-only"

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

release-dry-run: check
    bash scripts/release-dry-run.sh
