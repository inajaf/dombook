#!/usr/bin/env bash
# Run every end-to-end suite against a fresh stack.
#
#   scripts/e2e-all.sh
#
# Each suite drives the real Electron app over CDP. Suites that create accounts reset the auth
# tables themselves, so they are repeatable without a restart; the stack is brought up fresh
# once, because /auth/setup only bootstraps while no user exists.
set -uo pipefail

# Resolve the repository root from this script's own location rather than an absolute path,
# so the suites run from any clone (or CI checkout).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "${ROOT}/package.json" ]; then
  echo "cannot locate the repository root (looked in ${ROOT})" >&2
  exit 1
fi
cd "$ROOT"
# shellcheck source=scripts/db-env.sh
source "${ROOT}/scripts/db-env.sh"

# Fail once, with the fix, rather than letting six suites each report a connection error.
if ! db_reachable; then
  echo "no database at ${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT} — start it with: scripts/db.sh up" >&2
  exit 1
fi

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
run "interface" scripts/e2e-interface.mjs
run "pricing"   scripts/e2e-pricing.mjs
run "documents" scripts/e2e-documents.mjs
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
