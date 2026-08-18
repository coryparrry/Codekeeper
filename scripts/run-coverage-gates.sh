#!/usr/bin/env bash
set -euo pipefail

(( $# >= 3 )) || {
  echo 'usage: run-coverage-gates.sh CONFIG COMMAND [ARG...]' >&2
  exit 2
}

config=$1
shift
report=$(mktemp "${TMPDIR:-/tmp}/codekeeper-coverage.XXXXXX")
cleanup() {
  rm -f "$report"
}
trap cleanup EXIT

set +e
"$@" 2>&1 | tee "$report"
status=${PIPESTATUS[0]}
set -e
(( status == 0 )) || exit "$status"

node "$(dirname "$0")/check-critical-coverage.mjs" \
  --report "$report" \
  --config "$config"
