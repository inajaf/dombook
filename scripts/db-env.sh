#!/usr/bin/env bash
# The one place that decides HOW TO REACH THE DEVELOPMENT DATABASE.
#
# Sourced by scripts/db.sh, scripts/e2e-stack.sh, scripts/check-all.sh and scripts/e2e-all.sh.
# It exists because the same coordinates were previously duplicated across those scripts, and
# a single stale copy is how a suite ends up testing one database while the server serves
# another — the failure looks like a product bug and costs an afternoon.
#
# Defaults point at the Docker container (scripts/db.sh up). Override any of them to use a
# native PostgreSQL instead:
#
#   export DOMBOOK_DB_PORT=5432 DOMBOOK_DB_USER="$(whoami)" DOMBOOK_DB_PASSWORD=
#
# NOTHING HERE IS A SECRET. These are development credentials for a database that only ever
# listens on the loopback interface of the machine running it, which is why they are in the
# repository rather than in an untracked file. Production credentials come from the
# environment and are never defaulted; see server/README.md.

# shellcheck disable=SC2034  # the whole point of this file is to be sourced
{
  DOMBOOK_DB_HOST="${DOMBOOK_DB_HOST:-127.0.0.1}"
  # 55432 by default: a Homebrew PostgreSQL is often already bound to 5432, and a collision
  # there either fails to start or silently connects to the wrong server.
  DOMBOOK_DB_PORT="${DOMBOOK_DB_PORT:-55432}"
  DOMBOOK_DB_USER="${DOMBOOK_DB_USER:-dombook}"
  DOMBOOK_DB_PASSWORD="${DOMBOOK_DB_PASSWORD:-dombook}"

  # The role the container is initialised with, which owns the databases and is the only one
  # that can CREATE DATABASE or apply migrations. Distinct from the application role the API
  # runs as: that one is deliberately unprivileged so row-level security applies to it.
  DOMBOOK_DB_ADMIN_USER="${DOMBOOK_DB_ADMIN_USER:-dombook}"
  DOMBOOK_DB_ADMIN_PASSWORD="${DOMBOOK_DB_ADMIN_PASSWORD:-dombook}"

  DOMBOOK_DEV_DB="${DOMBOOK_DEV_DB:-dombook_dev}"
  DOMBOOK_TEST_DB="${DOMBOOK_TEST_DB:-dombook_test}"
  DOMBOOK_E2E_DB="${DOMBOOK_E2E_DB:-dombook_e2e}"

  # The credentials the API and the e2e stack give the two application roles. Development
  # only: tests set them, and a migration never sets a password on purpose, so no default
  # credential can ship to production.
  DOMBOOK_APP_PASSWORD="${DOMBOOK_APP_PASSWORD:-app}"
  DOMBOOK_ADMIN_PASSWORD="${DOMBOOK_ADMIN_PASSWORD:-adminpw}"
}

# Owner DSN for a database: apply migrations with this.
db_owner_dsn() {
  local database="$1"
  if [ -n "$DOMBOOK_DB_ADMIN_PASSWORD" ]; then
    echo "postgres://${DOMBOOK_DB_ADMIN_USER}:${DOMBOOK_DB_ADMIN_PASSWORD}@${DOMBOOK_DB_HOST}:${DOMBOOK_DB_PORT}/${database}?sslmode=disable"
  else
    echo "postgres://${DOMBOOK_DB_ADMIN_USER}@${DOMBOOK_DB_HOST}:${DOMBOOK_DB_PORT}/${database}?sslmode=disable"
  fi
}

# The application role's DSN: what the API actually serves traffic as.
app_role_dsn() {
  local database="$1"
  echo "postgres://dombook_app:${DOMBOOK_APP_PASSWORD}@${DOMBOOK_DB_HOST}:${DOMBOOK_DB_PORT}/${database}?sslmode=disable"
}

# psql as the owner. PGPASSWORD is used rather than a URL so the password never reaches the
# process list, where any local user could read it.
psql_owner() {
  PGPASSWORD="$DOMBOOK_DB_ADMIN_PASSWORD" psql \
    -h "$DOMBOOK_DB_HOST" -p "$DOMBOOK_DB_PORT" -U "$DOMBOOK_DB_ADMIN_USER" "$@"
}

# Is the database reachable at all? Used to fail fast with instructions instead of letting a
# suite report dozens of connection errors.
db_reachable() {
  PGPASSWORD="$DOMBOOK_DB_ADMIN_PASSWORD" pg_isready \
    -h "$DOMBOOK_DB_HOST" -p "$DOMBOOK_DB_PORT" -U "$DOMBOOK_DB_ADMIN_USER" >/dev/null 2>&1
}
