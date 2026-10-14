#!/usr/bin/env bash
# Every check that must pass before work is reported as done.
#
#   scripts/check-all.sh          unit suites and the Go server (fast, no browser)
#   scripts/check-all.sh --e2e    ... plus the 90-odd end-to-end checks against the real app
#
# This exists so "I ran the checks" means one command with one verdict, rather than a list
# someone can shorten under time pressure. It is also what an agent is expected to run before
# saying a change is finished, so the definition of done is executable instead of aspirational.
#
# It does NOT start the database. Run `scripts/db.sh up` first; the script says so if the
# database is unreachable, because a suite failing on connection errors looks like code rot.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/db-env.sh
source "${ROOT}/scripts/db-env.sh"

RUN_E2E=0
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=1 ;;
    -h|--help) echo "usage: $0 [--e2e]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

failed=0
declare -a failures=()

run() {
  local name="$1"; shift
  echo
  echo "=== ${name} ==="
  if "$@"; then
    echo "--- ok: ${name}"
  else
    echo "--- FAILED: ${name}"
    failed=$((failed + 1))
    failures+=("$name")
  fi
}

# --- Database ------------------------------------------------------------------
# Checked first and reported once. Without this, every Go package fails with a connection
# error and the actual cause is buried under a hundred lines of them.
echo "=== database ==="
if db_reachable; then
  echo "reachable at ${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT}"
else
  echo "no database at ${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT}" >&2
  echo "start it with: scripts/db.sh up" >&2
  exit 1
fi

# --- Desktop -------------------------------------------------------------------
run "desktop unit tests" npm test
run "desktop smoke test" npm run test:smoke

# --- Go server -----------------------------------------------------------------
# -p 1 is required, not an optimisation: the integration packages share one database and each
# resets the schema, so parallel package processes fight over it. See server/README.md.
run "go build" bash -c 'cd server && go build ./...'
run "go vet" bash -c 'cd server && go vet ./...'
run "go test (serial, race)" env \
  "RENTKEEPER_TEST_DSN=postgres://${RENTKEEPER_DB_ADMIN_USER}:${RENTKEEPER_DB_ADMIN_PASSWORD}@${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT}/${RENTKEEPER_TEST_DB}?sslmode=disable" \
  bash -c 'cd server && go test -p 1 -race -count=1 ./...'

# gofmt is a reporting command: it exits 0 even when it prints files, so the output is what
# decides. A silent pass here would let unformatted code through unnoticed.
run "gofmt" bash -c 'unformatted=$(cd server && gofmt -l .); if [ -n "$unformatted" ]; then echo "not gofmt-clean:"; echo "$unformatted"; exit 1; fi'

# --- End to end ----------------------------------------------------------------
if [ "$RUN_E2E" -eq 1 ]; then
  run "end-to-end suites" bash scripts/e2e-all.sh
else
  echo
  echo "=== end-to-end suites skipped (pass --e2e to include them) ==="
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "${failed} CHECK(S) FAILED:"
  for name in "${failures[@]}"; do echo "  - ${name}"; done
fi
exit "$failed"
