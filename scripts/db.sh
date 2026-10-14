#!/usr/bin/env bash
# Bring the development database up in Docker, ready for the server, the migrations and both
# test suites.
#
#   scripts/db.sh up      start PostgreSQL, create the dev and test databases
#   scripts/db.sh down    stop it (the data volume is kept)
#   scripts/db.sh reset   drop and recreate both databases
#   scripts/db.sh status  report what is running and whether both databases exist
#
# One command rather than a documented sequence of psql calls, because the sequence is what
# goes stale: the server needs dombook_dev, the Go integration tests need dombook_test, and a
# container created from the compose file only has the first one. Doing it here means a new
# machine, CI, and an agent all reach the same state the same way.
#
# Host, port and credentials come from scripts/db-env.sh and are overridable, so a native
# PostgreSQL works just as well.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/db-env.sh
source "${ROOT}/scripts/db-env.sh"

# Administration statements run against dombook_dev: they are about the cluster (roles,
# databases), not about the contents of any one database.
query() {
  psql_owner -d "$DOMBOOK_DEV_DB" -qtAX -c "$1"
}

# Wait for the server to accept connections rather than sleeping for a guessed interval.
wait_for_db() {
  for _ in $(seq 1 60); do
    if db_reachable; then
      return 0
    fi
    sleep 1
  done
  echo "PostgreSQL at ${DOMBOOK_DB_HOST}:${DOMBOOK_DB_PORT} did not become ready" >&2
  echo "check it with: docker compose logs postgres" >&2
  return 1
}

# `CREATE DATABASE` has no IF NOT EXISTS and cannot run inside a transaction, so the
# existence check is a separate statement from the create.
database_exists() {
  [ "$(query "SELECT 1 FROM pg_database WHERE datname = '${1}'")" = "1" ]
}

ensure_database() {
  if database_exists "$1"; then
    echo "  $1: present"
  else
    query "CREATE DATABASE $1" >/dev/null
    echo "  $1: created"
  fi
}

recreate_database() {
  # Terminate other sessions first, or the DROP blocks on the app's own connection and reads
  # as a hang rather than as a busy database.
  query "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = '${1}' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  query "DROP DATABASE IF EXISTS $1" >/dev/null
  query "CREATE DATABASE $1" >/dev/null
  echo "  $1: recreated"
}

case "${1:-up}" in
  up)
    docker compose up -d postgres
    wait_for_db
    echo "databases on ${DOMBOOK_DB_HOST}:${DOMBOOK_DB_PORT}:"
    ensure_database "$DOMBOOK_DEV_DB"
    ensure_database "$DOMBOOK_TEST_DB"
    # The two application roles are created by migration 0003. Roles are cluster-level, so
    # running the migrations against one database is enough for both.
    echo "next: (cd server && go run ./cmd/migrate up) with"
    echo "  DOMBOOK_DSN=$(db_owner_dsn "$DOMBOOK_DEV_DB")"
    ;;
  down)
    docker compose down
    echo "stopped (the postgres-data volume is kept; 'scripts/db.sh reset' recreates the databases)"
    ;;
  reset)
    wait_for_db
    echo "recreating:"
    recreate_database "$DOMBOOK_DEV_DB"
    recreate_database "$DOMBOOK_TEST_DB"
    echo "run the migrations next: (cd server && go run ./cmd/migrate up)"
    ;;
  status)
    docker compose ps postgres || true
    if db_reachable; then
      echo "reachable at ${DOMBOOK_DB_HOST}:${DOMBOOK_DB_PORT}"
      for db in "$DOMBOOK_DEV_DB" "$DOMBOOK_TEST_DB"; do
        if database_exists "$db"; then
          echo "  ${db}: present"
        else
          echo "  ${db}: MISSING (run: scripts/db.sh up)"
        fi
      done
    else
      echo "not reachable at ${DOMBOOK_DB_HOST}:${DOMBOOK_DB_PORT} (run: scripts/db.sh up)" >&2
      exit 1
    fi
    ;;
  *) echo "usage: $0 {up|down|reset|status}" >&2; exit 2 ;;
esac
