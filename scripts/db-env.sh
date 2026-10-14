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
#   export RENTKEEPER_DB_PORT=5432 RENTKEEPER_DB_USER="$(whoami)" RENTKEEPER_DB_PASSWORD=
#
# NOTHING HERE IS A SECRET. These are development credentials for a database that only ever
# listens on the loopback interface of the machine running it, which is why they are in the
# repository rather than in an untracked file. Production credentials come from the
# environment and are never defaulted; see server/README.md.

# The old DOMBOOK_* names still work and are read as a fallback.
#
# The desktop's userData directory and its SQLite filename were kept as `dombook-desktop` and
# `dombook.sqlite` on purpose: renaming those would move every existing user's data (see
# AGENTS.md). The environment variables have no such constraint — nothing on a user's disk is
# named after them — but a developer's shell profile or .env may already export them, so they
# keep resolving rather than silently falling back to the Docker container's defaults while
# the developer believes they are pointing at their own database. Set the RENTKEEPER_* name;
# the DOMBOOK_* one is honoured only when the new name is absent.
# shellcheck disable=SC2034  # the whole point of this file is to be sourced
{
  RENTKEEPER_DB_HOST="${RENTKEEPER_DB_HOST:-${DOMBOOK_DB_HOST:-127.0.0.1}}"
  # 55432 by default: a Homebrew PostgreSQL is often already bound to 5432, and a collision
  # there either fails to start or silently connects to the wrong server.
  RENTKEEPER_DB_PORT="${RENTKEEPER_DB_PORT:-${DOMBOOK_DB_PORT:-55432}}"
  RENTKEEPER_DB_USER="${RENTKEEPER_DB_USER:-${DOMBOOK_DB_USER:-rentkeeper}}"
  RENTKEEPER_DB_PASSWORD="${RENTKEEPER_DB_PASSWORD:-${DOMBOOK_DB_PASSWORD:-rentkeeper}}"

  # The role the container is initialised with, which owns the databases and is the only one
  # that can CREATE DATABASE or apply migrations. Distinct from the application role the API
  # runs as: that one is deliberately unprivileged so row-level security applies to it.
  RENTKEEPER_DB_ADMIN_USER="${RENTKEEPER_DB_ADMIN_USER:-${DOMBOOK_DB_ADMIN_USER:-rentkeeper}}"
  RENTKEEPER_DB_ADMIN_PASSWORD="${RENTKEEPER_DB_ADMIN_PASSWORD:-${DOMBOOK_DB_ADMIN_PASSWORD:-rentkeeper}}"

  RENTKEEPER_DEV_DB="${RENTKEEPER_DEV_DB:-${DOMBOOK_DEV_DB:-rentkeeper_dev}}"
  RENTKEEPER_TEST_DB="${RENTKEEPER_TEST_DB:-${DOMBOOK_TEST_DB:-rentkeeper_test}}"
  RENTKEEPER_E2E_DB="${RENTKEEPER_E2E_DB:-${DOMBOOK_E2E_DB:-rentkeeper_e2e}}"

  # The passwords given to the two application roles. Development only: the test harness sets
  # them, and a migration never does on purpose, so no default credential can ship to
  # production. The role NAMES live in migration 0010 and in internal/testdb.
  RENTKEEPER_APP_PASSWORD="${RENTKEEPER_APP_PASSWORD:-${DOMBOOK_APP_PASSWORD:-app}}"
  RENTKEEPER_ADMIN_PASSWORD="${RENTKEEPER_ADMIN_PASSWORD:-${DOMBOOK_ADMIN_PASSWORD:-adminpw}}"

  # Kept as spellings of the same values, so a caller that still reads DOMBOOK_DB_* keeps
  # working. New code must use the RENTKEEPER_ names.
  DOMBOOK_DB_HOST="$RENTKEEPER_DB_HOST"
  DOMBOOK_DB_PORT="$RENTKEEPER_DB_PORT"
  DOMBOOK_DB_ADMIN_USER="$RENTKEEPER_DB_ADMIN_USER"
  DOMBOOK_DB_ADMIN_PASSWORD="$RENTKEEPER_DB_ADMIN_PASSWORD"
  DOMBOOK_E2E_DB="$RENTKEEPER_E2E_DB"
  DOMBOOK_APP_PASSWORD="$RENTKEEPER_APP_PASSWORD"
  DOMBOOK_ADMIN_PASSWORD="$RENTKEEPER_ADMIN_PASSWORD"
  export RENTKEEPER_DB_HOST RENTKEEPER_DB_PORT RENTKEEPER_DB_USER RENTKEEPER_DB_PASSWORD \
         RENTKEEPER_DB_ADMIN_USER RENTKEEPER_DB_ADMIN_PASSWORD \
         RENTKEEPER_DEV_DB RENTKEEPER_TEST_DB RENTKEEPER_E2E_DB \
         RENTKEEPER_APP_PASSWORD RENTKEEPER_ADMIN_PASSWORD \
         DOMBOOK_DB_HOST DOMBOOK_DB_PORT DOMBOOK_DB_ADMIN_USER DOMBOOK_DB_ADMIN_PASSWORD \
         DOMBOOK_E2E_DB DOMBOOK_APP_PASSWORD DOMBOOK_ADMIN_PASSWORD
}

# Owner DSN for a database: apply migrations with this.
db_owner_dsn() {
  local database="$1"
  if [ -n "$RENTKEEPER_DB_ADMIN_PASSWORD" ]; then
    echo "postgres://${RENTKEEPER_DB_ADMIN_USER}:${RENTKEEPER_DB_ADMIN_PASSWORD}@${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT}/${database}?sslmode=disable"
  else
    echo "postgres://${RENTKEEPER_DB_ADMIN_USER}@${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT}/${database}?sslmode=disable"
  fi
}

# The application role's DSN: what the API actually serves traffic as.
#
# The role name is the one migration 0010 creates. It is deliberately not configurable: the
# isolation tests assert this exact role cannot bypass RLS, and a DSN that could name a
# different one would make that assertion describe nothing.
app_role_dsn() {
  local database="$1"
  echo "postgres://rentkeeper_app:${RENTKEEPER_APP_PASSWORD}@${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT}/${database}?sslmode=disable"
}

# The operator role's DSN: what the admin surface connects as.
admin_role_dsn() {
  local database="$1"
  echo "postgres://rentkeeper_admin:${RENTKEEPER_ADMIN_PASSWORD}@${RENTKEEPER_DB_HOST}:${RENTKEEPER_DB_PORT}/${database}?sslmode=disable"
}

# psql as the owner. PGPASSWORD is used rather than a URL so the password never reaches the
# process list, where any local user could read it.
psql_owner() {
  PGPASSWORD="$RENTKEEPER_DB_ADMIN_PASSWORD" psql \
    -h "$RENTKEEPER_DB_HOST" -p "$RENTKEEPER_DB_PORT" -U "$RENTKEEPER_DB_ADMIN_USER" "$@"
}

# Is the database reachable at all? Used to fail fast with instructions instead of letting a
# suite report dozens of connection errors.
db_reachable() {
  PGPASSWORD="$RENTKEEPER_DB_ADMIN_PASSWORD" pg_isready \
    -h "$RENTKEEPER_DB_HOST" -p "$RENTKEEPER_DB_PORT" -U "$RENTKEEPER_DB_ADMIN_USER" >/dev/null 2>&1
}
