#!/usr/bin/env bash
# Start (or restart) the full local stack for end-to-end testing.
#
#   scripts/e2e-stack.sh up      fresh database, migrations, API, desktop app
#   scripts/e2e-stack.sh api     restart only the API
#   scripts/e2e-stack.sh app     restart only the desktop app
#   scripts/e2e-stack.sh down    stop everything
#
# A fresh database is the default for `up` because /auth/setup bootstraps the first owner
# account and refuses afterwards — reusing a database makes signup fail for reasons that look
# like bugs.
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"

# Resolve the repository root from this script's own location, so the stack can be brought up
# from any clone (or CI checkout) instead of only the machine it was written on.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "${ROOT}/package.json" ]; then
  echo "cannot locate the repository root (looked in ${ROOT})" >&2
  exit 1
fi
# shellcheck source=scripts/db-env.sh
source "${ROOT}/scripts/db-env.sh"

DB="$RENTKEEPER_E2E_DB"
PORT="${RENTKEEPER_E2E_PORT:-8787}"
CDP_PORT="${CDP_PORT:-9555}"

# Its own database, so a run cannot destroy development data, but on the SAME server the rest
# of the project uses. A separate instance here is how the suites drift onto a schema the
# server does not have.
PSQL=(psql -h "$RENTKEEPER_DB_HOST" -p "$RENTKEEPER_DB_PORT" -U "$RENTKEEPER_DB_ADMIN_USER")
export PGPASSWORD="$RENTKEEPER_DB_ADMIN_PASSWORD"

stop_app() {
  # Match the binary path, not "MacOS/Electron ." — the main process is launched as
  # `.../MacOS/Electron <project> --remote-debugging-port=...`, so a pattern anchored on a
  # trailing space misses it, the old process keeps the CDP port, and the new one dies with
  # "bind() failed: Address already in use". The symptom is a suite that hangs at connect.
  pkill -9 -f "electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null || true
  for pid in $(pgrep -f "MacOS/Electron" 2>/dev/null || true); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 2
  # Wait for the debug port to actually be free before starting another app.
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:"${CDP_PORT}" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  echo "warning: port ${CDP_PORT} is still held" >&2
}
stop_api() { pkill -f "/tmp/rentkeeper-api" 2>/dev/null || true; sleep 1; }
start_api() {
  cd "$ROOT/server"
  go build -o /tmp/rentkeeper-api ./cmd/api
  RENTKEEPER_DSN="$(app_role_dsn "$DB")" \
  RENTKEEPER_SKIP_MIGRATE=1 \
  RENTKEEPER_ADMIN_DSN="$(admin_role_dsn "$DB")" \
  ADMIN_API_KEY="e2e-admin-key-long-enough-value" \
  JWT_SECRET="e2e-run-secret-value-16chars" \
  RENTKEEPER_ADDR="127.0.0.1:${PORT}" AUTH_EXPOSE_CODE=true \
  /tmp/rentkeeper-api > /tmp/e2e-api.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "API did not start; see /tmp/e2e-api.log" >&2; tail -5 /tmp/e2e-api.log >&2; return 1
}
start_app() {
  rm -rf "$HOME/Library/Application Support/rentkeeper-desktop"
  # The app path is passed EXPLICITLY. Electron resolves "." against the working directory,
  # not against a project path, so launching from elsewhere silently starts whatever package
  # happens to sit in the cwd — and the app then never exposes CDP on the expected port.
  env -u ELECTRON_RUN_AS_NODE RENTKEEPER_API_URL="http://127.0.0.1:${PORT}" \
    "${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$ROOT" \
    --remote-debugging-port="${CDP_PORT}" > /tmp/e2e-app.log 2>&1 &
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:${CDP_PORT}/json/list" >/dev/null 2>&1 && { sleep 2; return 0; }
    sleep 0.5
  done
  echo "app did not expose CDP; see /tmp/e2e-app.log" >&2; tail -5 /tmp/e2e-app.log >&2; return 1
}

case "${1:-up}" in
  up)
    stop_app; stop_api
    # Fail with instructions rather than letting a dozen suites report connection errors.
    if ! db_reachable; then
      echo "no database at ${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT} — run: scripts/db.sh up" >&2
      exit 1
    fi
    "${PSQL[@]}" -d "$RENTKEEPER_DEV_DB" -q -c "DROP DATABASE IF EXISTS \"${DB}\"" 2>/dev/null || true
    "${PSQL[@]}" -d "$RENTKEEPER_DEV_DB" -q -c "CREATE DATABASE \"${DB}\""
    cd "$ROOT/server"
    # Migrations run as the database owner, which is the role that owns the objects they
    # create. Keep ONE migration role per database: 0003's ALTER DEFAULT PRIVILEGES binds to
    # that role, and a different one would silently stop granting the app role access to
    # tables added later.
    RENTKEEPER_DSN="$(db_owner_dsn "$DB")" go run ./cmd/migrate up >/dev/null
    # Both roles already exist at this point: 0003_roles.sql creates them with their correct
    # attributes (NOBYPASSRLS for the app, BYPASSRLS for admin). Only the passwords are local
    # to this script — a migration deliberately never sets one, so no default credential can
    # ship to production. These are the credentials start_api connects with above.
    "${PSQL[@]}" -d "$DB" -q -c "ALTER ROLE rentkeeper_app WITH PASSWORD '${RENTKEEPER_APP_PASSWORD}'; ALTER ROLE rentkeeper_admin WITH PASSWORD '${RENTKEEPER_ADMIN_PASSWORD}';"
    start_api
    start_app
    echo "stack up: api http://127.0.0.1:${PORT}  cdp ${CDP_PORT}  db ${DB} at ${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT}"
    ;;
  api) stop_api; start_api; echo "api restarted" ;;
  app) stop_app; start_app; echo "app restarted" ;;
  down)
    stop_app; stop_api
    "${PSQL[@]}" -d "$RENTKEEPER_DEV_DB" -q -c "DROP DATABASE IF EXISTS \"${DB}\"" 2>/dev/null || true
    echo "stack down"
    ;;
  *) echo "usage: $0 {up|api|app|down}" >&2; exit 2 ;;
esac
