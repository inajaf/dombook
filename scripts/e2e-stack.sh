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
ROOT="/Users/eldar/Projects/Book program"
DB="${DOMBOOK_E2E_DB:-dombook_e2e}"
PORT="${DOMBOOK_E2E_PORT:-8787}"
CDP_PORT="${CDP_PORT:-9555}"

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
stop_api() { pkill -f "/tmp/dombook-api" 2>/dev/null || true; sleep 1; }
start_api() {
  cd "$ROOT/server"
  go build -o /tmp/dombook-api ./cmd/api
  DOMBOOK_DSN="postgres://dombook_app:app@127.0.0.1:5432/${DB}?sslmode=disable" \
  DOMBOOK_SKIP_MIGRATE=1 \
  DOMBOOK_ADMIN_DSN="postgres://dombook_admin:adminpw@127.0.0.1:5432/${DB}?sslmode=disable" \
  ADMIN_API_KEY="e2e-admin-key-long-enough-value" \
  JWT_SECRET="e2e-run-secret-value-16chars" \
  DOMBOOK_ADDR="127.0.0.1:${PORT}" AUTH_EXPOSE_CODE=true \
  /tmp/dombook-api > /tmp/e2e-api.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "API did not start; see /tmp/e2e-api.log" >&2; tail -5 /tmp/e2e-api.log >&2; return 1
}
start_app() {
  cd "$ROOT"
  rm -rf "$HOME/Library/Application Support/rentkeeper-desktop"
  env -u ELECTRON_RUN_AS_NODE DOMBOOK_API_URL="http://127.0.0.1:${PORT}" \
    ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
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
    dropdb --if-exists "$DB" 2>/dev/null || true
    createdb "$DB"
    cd "$ROOT/server"
    DOMBOOK_DSN="postgres://eldar@127.0.0.1:5432/${DB}?sslmode=disable" go run ./cmd/migrate up >/dev/null
    psql -d "$DB" -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dombook_app') THEN CREATE ROLE dombook_app LOGIN NOBYPASSRLS; END IF; END \$\$;"
    psql -d "$DB" -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dombook_admin') THEN CREATE ROLE dombook_admin LOGIN BYPASSRLS; END IF; END \$\$;"
    psql -d "$DB" -q -c "ALTER ROLE dombook_app WITH PASSWORD 'app'; ALTER ROLE dombook_admin WITH PASSWORD 'adminpw';"
    start_api
    start_app
    echo "stack up: api http://127.0.0.1:${PORT}  cdp ${CDP_PORT}  db ${DB}"
    ;;
  api) stop_api; start_api; echo "api restarted" ;;
  app) stop_app; start_app; echo "app restarted" ;;
  down) stop_app; stop_api; dropdb --if-exists "$DB" 2>/dev/null || true; echo "stack down" ;;
  *) echo "usage: $0 {up|api|app|down}" >&2; exit 2 ;;
esac
