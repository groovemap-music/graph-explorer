#!/usr/bin/env bash
set -euo pipefail
design_repo="${GROOVEMAP_DESIGN_REPO:-../design}"
expected="41be7cbe738f40df0c75ad7065475e91d6cc2aa4"
test -e "${design_repo}/.git"
test "$(git -C "${design_repo}" rev-parse HEAD)" = "${expected}"
test -z "$(git -C "${design_repo}" status --short)"
node "${design_repo}/brand/render.mjs" --check
find explore/static/brand -type f ! -name source.json -depth -delete
cp "${design_repo}"/brand/assets/* explore/static/brand/
python scripts/check-brand.py
