#!/usr/bin/env bash
set -uo pipefail

projects=(chromium firefox webkit iphone ipad)
status=0
for project in "${projects[@]}"; do
  echo "Running graph-explorer E2E project: ${project}"
  # pytest-playwright clears its output directory at process start. Give every
  # project a distinct directory so a later browser cannot erase an earlier
  # browser's failure evidence.
  if ! GROOVEMAP_E2E_PROJECT="${project}" uv run pytest -m e2e \
    --output="test-results/${project}/playwright"; then
    status=1
  fi
done
exit "${status}"
