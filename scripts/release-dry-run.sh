#!/usr/bin/env bash
set -euo pipefail
uv build --out-dir dist --clear
node explore/scripts/vendor-licenses.mjs check
mkdir -p dist/WEB_THIRD_PARTY_NOTICES
cp explore/static/vendor/ASSET_LICENSES.json explore/static/vendor/THIRD_PARTY_NOTICES.md dist/WEB_THIRD_PARTY_NOTICES/
cp -R explore/static/vendor/licenses dist/WEB_THIRD_PARTY_NOTICES/licenses
mkdir -p dist/LEGAL
cp LICENSE NOTICE COMMERCIAL-LICENSING.md BRAND-NOTICE.md dist/LEGAL/
(
  cd dist
  shasum -a 256 ./*.whl ./*.tar.gz > SHA256SUMS
)
uv run cyclonedx-py environment --output-file dist/sbom.json
uv run pip-licenses --format=json --output-file=dist/THIRD_PARTY_NOTICES.json
uv run python scripts/write-build-provenance.py
test -s dist/SHA256SUMS
test -s dist/sbom.json
test -s dist/THIRD_PARTY_NOTICES.json
test -s dist/WEB_THIRD_PARTY_NOTICES/THIRD_PARTY_NOTICES.md
test -s dist/WEB_THIRD_PARTY_NOTICES/ASSET_LICENSES.json
test "$(find dist/WEB_THIRD_PARTY_NOTICES/licenses -type f | wc -l | tr -d ' ')" = "10"
test "$(find dist/LEGAL -type f | wc -l | tr -d ' ')" = "4"
test -s dist/LEGAL/LICENSE
test -s dist/LEGAL/NOTICE
test -s dist/LEGAL/COMMERCIAL-LICENSING.md
test -s dist/LEGAL/BRAND-NOTICE.md
test -s dist/provenance.json
