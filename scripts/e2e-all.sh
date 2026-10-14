#!/usr/bin/env bash
# Run every end-to-end suite against a fresh stack.
#
#   scripts/e2e-all.sh
#
# Each suite drives the real Electron app over CDP. Suites that create accounts reset the auth
# tables themselves, so they are repeatable without a restart; the stack is brought up fresh
# once, because /auth/setup only bootstraps while no user exists.
set -uo pipefail
ROOT="/Users/eldar/Projects/Book program"
cd "$ROOT"

bash scripts/e2e-stack.sh up || exit 1

failed=0
run() {
  local name="$1"; shift
  echo
  if node "$@"; then
    echo "  ✔ $name"
  else
    echo "  ✘ $name"
    failed=$((failed + 1))
  fi
}

run "scenarios" scripts/e2e-scenarios.mjs
run "booking"   scripts/e2e-booking.mjs
run "branding"  scripts/e2e-branding.mjs
run "operations" scripts/e2e-operations.mjs
run "security"  scripts/e2e-security.mjs
run "sync"      scripts/e2e-sync.mjs

echo
if [ "$failed" -eq 0 ]; then
  echo "ALL END-TO-END SUITES PASSED"
else
  echo "$failed SUITE(S) FAILED"
fi
exit "$failed"
