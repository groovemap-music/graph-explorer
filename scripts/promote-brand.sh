#!/usr/bin/env bash
set -euo pipefail
design_repo="${GROOVEMAP_DESIGN_REPO:-../design}"
expected="7abe13ad3e22e81b5437eb92acb8db998730e11a"
test -e "${design_repo}/.git"
test "$(git -C "${design_repo}" rev-parse HEAD)" = "${expected}"
test -z "$(git -C "${design_repo}" status --short)"
node "${design_repo}/brand/render.mjs" --check
find explore/static/brand -type f ! -name source.json -depth -delete
cp "${design_repo}"/brand/assets/* explore/static/brand/
python scripts/check-brand.py
