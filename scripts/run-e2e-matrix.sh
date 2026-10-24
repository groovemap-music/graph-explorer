#!/usr/bin/env bash
set -uo pipefail

# The five browser projects run as concurrent pytest processes. Run one after another they take
# about 45 minutes on a hosted runner, which is the whole Required-validation budget.
#
# Each project already owns everything it writes, so running them side by side changes nothing they
# produce: its app server listens on a socket only that process holds (tests/conftest.py), and its
# Playwright output, videos, failure artifacts and log live under test-results/<project> and its
# Istanbul coverage under coverage/e2e/raw/<project>, which is where finalize-e2e-coverage.mjs and
# the CI browser-coverage mapping read them.
#
# GROOVEMAP_E2E_JOBS bounds how many projects run at once. It defaults to the CPU count, and more
# than one per project would only sit idle. Longest first, so the project that waits for a free
# slot is one of the shorter ones.
projects=(firefox chromium webkit iphone ipad)

jobs="${GROOVEMAP_E2E_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)}"
if ! [[ "${jobs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "GROOVEMAP_E2E_JOBS must be a positive integer, got: ${jobs}" >&2
  exit 2
fi
if (( jobs > ${#projects[@]} )); then
  jobs=${#projects[@]}
fi

run_project() {
  local project="$1"
  mkdir -p "test-results/${project}"
  # pytest-playwright clears its output directory at process start. Give every project a distinct
  # directory so another browser cannot erase this browser's failure evidence. The pytest cache is
  # per project too, so concurrent sessions do not overwrite each other's last-failed record.
  GROOVEMAP_E2E_PROJECT="${project}" uv run pytest -m e2e \
    --output="test-results/${project}/playwright" \
    -o cache_dir=".pytest_cache/e2e-${project}" 2>&1 \
    | tee "test-results/${project}/pytest.log" \
    | awk -v prefix="[${project}] " '{ print prefix $0; fflush() }'
}

running_pids=()
running_projects=()
running_started=()
summary=()
failed=()

# Every process below one, so an interrupt stops a project's whole tree (uv, pytest, the app server,
# Xvfb and the browser) instead of orphaning it.
descendants() {
  local child
  for child in $(pgrep -P "$1"); do
    echo "${child}"
    descendants "${child}"
  done
}

stop_running() {
  trap - INT TERM
  local pid child tree=()
  for pid in "${running_pids[@]+"${running_pids[@]}"}"; do
    tree+=("${pid}")
    while read -r child; do
      tree+=("${child}")
    done < <(descendants "${pid}")
  done
  if (( ${#tree[@]} > 0 )); then
    kill -TERM "${tree[@]}" 2>/dev/null
  fi
  wait
  exit "$1"
}
trap 'stop_running 130' INT
trap 'stop_running 143' TERM

# Wait for one running project to finish, and record how it ended.
reap_one() {
  local index pid project code
  while :; do
    for index in "${!running_pids[@]}"; do
      pid="${running_pids[index]}"
      if kill -0 "${pid}" 2>/dev/null; then
        continue
      fi
      project="${running_projects[index]}"
      wait "${pid}"
      code=$?
      if [[ "${code}" -eq 0 ]]; then
        summary+=("${project}: passed in $((SECONDS - running_started[index]))s")
      else
        summary+=("${project}: FAILED with exit status ${code} after $((SECONDS - running_started[index]))s")
        failed+=("${project}")
      fi
      echo "Finished graph-explorer E2E project: ${summary[${#summary[@]} - 1]}"
      unset "running_pids[index]" "running_projects[index]" "running_started[index]"
      running_pids=("${running_pids[@]+"${running_pids[@]}"}")
      running_projects=("${running_projects[@]+"${running_projects[@]}"}")
      running_started=("${running_started[@]+"${running_started[@]}"}")
      return
    done
    sleep 1
  done
}

echo "Running graph-explorer E2E projects ${projects[*]}, ${jobs} at a time"
for project in "${projects[@]}"; do
  while (( ${#running_pids[@]} >= jobs )); do
    reap_one
  done
  echo "Running graph-explorer E2E project: ${project}"
  run_project "${project}" </dev/null &
  running_pids+=("$!")
  running_projects+=("${project}")
  running_started+=("${SECONDS}")
done
while (( ${#running_pids[@]} > 0 )); do
  reap_one
done

# The live output above interleaves the projects. Repeat each failed project's log whole, so its
# failures read in order.
for project in "${failed[@]+"${failed[@]}"}"; do
  echo
  echo "===== graph-explorer E2E project ${project} failed; its log (test-results/${project}/pytest.log) ====="
  cat "test-results/${project}/pytest.log"
done

echo
echo "graph-explorer E2E matrix finished in ${SECONDS}s:"
printf '  %s\n' "${summary[@]}"
if (( ${#failed[@]} > 0 )); then
  exit 1
fi
exit 0
