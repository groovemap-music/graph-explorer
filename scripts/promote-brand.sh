#!/usr/bin/env bash
set -euo pipefail
design_repo="${GROOVEMAP_DESIGN_REPO:-../design}"
expected="59c9fd3c8bbdfa676e0b7bb3d463fc766c1f3c0d"
test -e "${design_repo}/.git"
test "$(git -C "${design_repo}" rev-parse HEAD)" = "${expected}"
test -z "$(git -C "${design_repo}" status --short)"
node "${design_repo}/brand/render.mjs" --check
find explore/static/brand -type f ! -name source.json -depth -delete
cp "${design_repo}"/brand/assets/* explore/static/brand/
python scripts/check-brand.py
