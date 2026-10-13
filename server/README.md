# RentKeeper server

Go + PostgreSQL backend for DomBook. Replaces the Cloudflare Workers/D1
legacy implementation, which has been removed (see `CUTOVER.md`)
(see the cutover step in the project plan).

## Requirements

- Go 1.26+
- PostgreSQL 16. The migrations create `pgcrypto`, `citext`, and `btree_gist`
  themselves, so no manual extension setup is needed.
- No external migration binary is required: migrations are embedded in the binary
  and applied by `internal/store`. `goose` remains optional for manual
  inspection and uses the same SQL and the same `goose_db_version` table.

## Local setup

Start PostgreSQL, then create the databases:

```bash
createdb dombook_dev
createdb dombook_test
```

Apply migrations (from `server/`):

```bash
export DOMBOOK_DSN="postgres://$(whoami)@127.0.0.1:5432/dombook_dev?sslmode=disable"
go run ./cmd/migrate up       # apply everything pending, then print status
go run ./cmd/migrate status   # list migrations and whether they are applied
```

`migrate reset` reverts every migration and requires `DOMBOOK_ALLOW_RESET=1`, so
dropping the schema cannot happen by accident.

The same files work with the goose CLI:

```bash
goose -dir internal/store/migrations postgres "$DOMBOOK_DSN" up
```

## Roles and the isolation model

Migrations create two roles. **The distinction is a security boundary, not
convenience** — do not collapse them:

| Role | Bypasses RLS | Used by |
|---|---|---|
| `dombook_app` | no | the API request path |
| `dombook_admin` | yes | platform admin: account lists, cross-tenant conflict review |

The API connects as `dombook_app`, which is subject to the row-level security
policies in `20260811000002_security.sql`. That is what makes tenant isolation
an enforcement guarantee rather than a coding convention: a bug in a `WHERE`
clause cannot leak another tenant's rows.

Admin operations use a second connection as `dombook_admin`. Administration
cannot be expressed under RLS (it spans tenants by definition), and the
alternative — an "is admin" session flag that policies check — would put a
potential bypass inside every policy. Keep the two credentials separate.

### The tenant session variable

Every request transaction must set the tenant before touching data:

```sql
SET LOCAL app.tenant_id = '<account uuid>';
```

`current_tenant_id()` returns `NULL` when it is unset, so an unscoped query
returns **zero rows** rather than everything. That failure mode is deliberate:
missing data is loud, a cross-tenant leak is silent.

## Pre-tenant operations and the RLS exceptions

Some operations legitimately run before a tenant is known. They cannot be
authorized by tenant-scoped policies, so each gets a narrowly-scoped
`SECURITY DEFINER` function instead:

| Function | Why it cannot be tenant-scoped |
|---|---|
| `bootstrap_account` | Signup creates the account, so the tenant does not exist yet |
| `count_users_for_bootstrap` | The "is this a new install?" gate runs before any tenant exists |
| `lookup_user_for_login` / `issue_login_code` / `consume_login_code` / `count_recent_login_codes` | Login happens before authentication |
| `lookup_session_for_auth` | The account is *read from* the session row, so a jti lookup cannot be tenant-scoped |
| `create_auth_session` | Minting a session IS the act of authenticating |
| `revoke_auth_session` / `revoke_user_sessions` | Must work from a token, and "sign out everywhere" spans devices |
| `lookup_pending_invite` / `create_login_invite` | The invited email has no user row yet |

**Rules for adding one:**

1. It owns exactly one operation, with explicit arguments and a fixed set of
   columns. If you need a second operation, add a second function.
2. Always `SET search_path = public, pg_temp`. Without it, a caller who can create
   objects earlier on the search path could shadow a referenced table and redirect
   a privileged write.
3. Always `REVOKE ALL ... FROM PUBLIC` before granting to `dombook_app`.
   PostgreSQL grants `EXECUTE` to `PUBLIC` by default.
4. `verification_codes` is deny-all by design: it has RLS enabled and **no
   policy**. Its only access path is the functions above. The migration assertion
   in `0002` exempts it explicitly, so do not add a policy to "fix" it.

## Authentication

Passwordless email OTP. The flow and its endpoint contract:

| Step | Endpoint | Notes |
|---|---|---|
| Bootstrap | `POST /auth/setup` | Open only while the installation has no users, then requires `SETUP_TOKEN` |
| Request a code | `POST /auth/send` | The response is `{ok, loginable, code?}`; `code` only when `AUTH_EXPOSE_CODE=true` |
| Exchange the code | `POST /auth/verify` | Returns an access token and a refresh token; joins the account if an invite is pending |
| Who am I | `GET /auth/me` | Signature **and** session-row check |
| Refresh | `POST /auth/refresh` | Rotates the refresh token |
| Sign out | `POST /auth/logout` | Revokes the session row; idempotent |

Design points worth preserving:

- **`/auth/send` must not reveal whether an address exists.** A code row is written
  for unknown addresses too, so the response shape and the work done are the same.
  Only `loginable` differs, and it is not an error.
- **Two independent throttles** on `/auth/send`: an in-memory minimum interval plus
  window cap, and a durable count in the database that survives a restart. `/auth/verify`
  locks an address after repeated wrong codes, because six digits is only a million
  possibilities.
- **One-time codes are hashed at rest** and burned by a single conditional `UPDATE`,
  so a code cannot be replayed even by concurrent requests.
- **Access tokens are short-lived (15 min) and checked against the `sessions` row**,
  so logout takes effect immediately instead of at natural expiry.
- **Refresh tokens rotate on every use.** Presenting an already-consumed token is
  treated as compromise: the whole family and every session for that user are
  revoked. The false positive (one forced re-login) is far cheaper than leaving a
  stolen credential live. A token whose family was revoked deliberately — a
  "sign out everywhere" — is rejected as an ordinary dead session instead, so the
  compromise path does not cry wolf on every logout.
- `Options.OnCodeGenerated` is a **test seam only**. It exists because a code for a
  non-loginable address is generated but never delivered, so the plaintext exists
  nowhere else. It must stay nil in production.

## Migration rules

- Migration filenames are `<timestamp>_<name>.sql`; goose orders by the number,
  so the prefix must be unique. Three migrations sharing a `0001_` prefix is a
  goose error, not a valid sequence.
- Dollar-quoted blocks (`DO $$ ... $$`, `CREATE OR REPLACE FUNCTION`) **must**
  be wrapped in `-- +goose StatementBegin` / `-- +goose StatementEnd`. Without
  them goose splits on the first internal `;` and fails with
  `unterminated dollar-quoted string`.
- `.sql` files are goose "no transaction" migrations. This is required, not
  cosmetic: `ALTER TABLE ... ADD CONSTRAINT ... EXCLUDE` cannot run inside a
  PostgreSQL transaction block, and `CREATE EXTENSION IF NOT EXISTS` cannot
  either. PostgreSQL's transactional DDL still applies to each individual
  statement.
- Run migrations as **one consistent role** per database. `ALTER DEFAULT
  PRIVILEGES` in 0003 binds to the migration role (the object owner); running
  migrations as a different role silently stops those grants from applying.
- Every tenant-scoped table must have RLS enabled **and** at least one policy.
  0002 fails the migration if either is missing, because RLS-on with no policy is
  deny-all and would present as "no data" instead of an error.
- When a migration replaces a function or a policy, drop the old object *by exact
  signature* in the Up section. PostgreSQL keeps same-named functions as
  overloads, and `DROP FUNCTION IF EXISTS <name>` fails on an ambiguous name — so
  an upgrade can otherwise leave a stale privileged function in place. Migration
  0004 does this for the superseded `bootstrap_account(uuid, text, text)`.
- Adding a tenant table without RLS, or RLS without a policy, fails the migration
  on purpose. `internal/store` tests assert this too.

### Reversibility

Migrations have explicit `-- +goose Down` sections and the full chain is
verified with up → down-to 0 → up. Down order is not arbitrary: RLS policies
reference `current_tenant_id()`, so policies are dropped before the function.

## Cutover from the legacy D1 backend

See `CUTOVER.md`. In short: `go run ./cmd/migrate-d1 -source <d1.sqlite> [-dry-run]`, with
`DOMBOOK_DSN` naming the destination. Then start the API with `DOMBOOK_SKIP_MIGRATE=1`, because
it connects as `dombook_app` and cannot create objects.

## Tests

```bash
export DOMBOOK_TEST_DSN="postgres://$(whoami)@127.0.0.1:5432/dombook_test?sslmode=disable"
go test -p 1 ./...
```

**`-p 1` is required, not optional.** Integration tests share one database, and
`go test ./...` runs packages as parallel processes. Two of them cannot both own the
same schema: one truncates tables while the other asserts on them. That used to
surface as intermittent failures — a stray `setup_denied` because another package's
user was still present, or `function does not exist` caught mid-rebuild — which
passed on a rerun and were easy to misdiagnose.

The test helper now records which binary owns the database and refuses a second live
one with this exact instruction, so the misuse fails immediately and says what to do.
A stale marker from a crashed run is detected by process liveness and reclaimed.

Without `DOMBOOK_TEST_DSN` the PostgreSQL integration tests **skip** rather than
fail, so the suite still runs on a machine without a database. CI must set it, or
tenant isolation goes untested.

To confirm a test actually detects a regression rather than passing for an unrelated
reason, mutate the schema and re-run with migrations skipped:

```bash
psql -d dombook_test -c "ALTER TABLE units DISABLE ROW LEVEL SECURITY;"
DOMBOOK_SKIP_MIGRATE=1 go test -p 1 ./internal/store/ -run TestTenantIsolation -count=1
psql -d dombook_test -c "ALTER TABLE units ENABLE ROW LEVEL SECURITY; ALTER TABLE units FORCE ROW LEVEL SECURITY;"
```

The integration tests connect as `dombook_app` — the unprivileged role. Running
them as a superuser would bypass RLS and make the isolation assertions pass for
the wrong reason, so the harness rewrites the DSN and asserts the role does not
have `BYPASSRLS`.

Domain tests run the shared fixtures in `fixtures/` at the repository root, the
same files the JavaScript suite uses (`tests/fixtures.test.cjs`). `go:embed`
cannot reach a parent directory, so the fixtures are copied into
`internal/domain/testdata/`; `TestEmbeddedFixturesMatchCanonical` fails if that
copy drifts.

When a fixture changes, re-copy:

```bash
cp fixtures/*.json server/internal/domain/testdata/
```
