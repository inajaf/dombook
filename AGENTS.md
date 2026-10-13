# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Schema & ids

Desktop domain tables (places, properties, reservations, reservation_nights, reservation_services, reservation_meals, app_settings, audit_log) use **UUID TEXT ids** plus sync columns `created_at`, `updated_at`, `deleted_at`, `version`, `last_writer`, matching the server's baseline (minus `tenant_id` — the desktop is single-tenant; the server calls a property a `unit`). `version` starts at 1 and every write bumps it. Legacy integer-id databases are migrated in-place by `migrateLegacyIntegerIds()` (`src/database.cjs`), registered as migration `sync_schema_v1`; the old `ensureColumn` mechanism is kept for backward compatibility. New rows need an explicit `crypto.randomUUID()` id; `last_insert_rowid()` is gone.

## Licences & entitlements (Go server)

The product is a **one-time purchase**, not a subscription. The rules live in
`server/internal/billing/catalog.go` — a SKU's name, duration, and what it unlocks. `accounts.plan`
is a **legacy subscription column and no longer decides anything**; both the service check and the
database trigger read `account_entitlements` via `account_is_paid()`. Reading the plan column
anywhere would let a customer who paid once fall back to the free cap.

- Perpetual is `expires_at IS NULL`, not a far-future date. A dated grant (annual, trial) differs
  only by having an expiry, so both models fit one table.
- A grant is never edited in place: refunds/revocations set `revoked_at`, so the history survives a
  payment dispute. `grant_entitlement` is idempotent on `(account, sku, reference)` because payment
  webhooks are retried on any non-2xx.
- `account_entitlements` is under RLS. Reads without a tenant context go through
  **SECURITY DEFINER functions** (`active_entitlements_for_account`, `entitlement_history_for_account`).
  `Store.WithAdmin` does **not** bypass RLS — it is a plain transaction, so a query without a tenant
  context returns zero rows and looks like a success. Use a definer function instead.
- The paid tier is **unlimited units** (`unitAllowance()` returns -1, reported as `unitLimit: null`),
  not a bigger number. The free tier is 1 active unit and 1 active place; archived/soft-deleted rows
  do not count.
- The desktop caches entitlements in `app_settings` and treats a missing/corrupt cache as the **free**
  tier. It does **not** refuse writes locally: the server owns enforcement, and refusing locally would
  lock out a licensed user offline and break the demo seed.
- There is **no payment endpoint in the Go server yet**. Entitlements are granted by an operator or a
  future webhook; the desktop's licence button says so rather than opening a subscription checkout.

## Cutover from D1

`server/CUTOVER.md` is the procedure. `server/cmd/migrate-d1` moves a D1 file into PostgreSQL;
`scripts/verify-cutover.mjs` checks a completed migration against a running server.

- The importer opens D1 **read-only**, does the whole import in **one transaction**, and
  **refuses a non-empty target**. Identity (ids AND row versions) is preserved verbatim, so
  desktop clients resume from their stored cursor instead of re-downloading — regenerating ids
  would make every client re-create its data as new rows.
- `properties`/`property_id` become `units`/`unit_id`; `tenant_state.version` carries the
  cursor across.
- **Sessions and one-time codes are deliberately NOT migrated** — credentials for the old
  deployment. Everyone signs in again.
- **`DOMBOOK_SKIP_MIGRATE=1` is required in production.** The API runs as `dombook_app`, which
  cannot create objects, so the startup migration pass fails with `permission denied for schema
  public`. `cmd/migrate` applies them as the owner instead. Do not "fix" this by running the API
  as a privileged role — that gives the request path a way around RLS.
- The Go baseline had **dropped `reservation_services.service_name`**, which the cutover caught:
  the column exists in D1 and holds the label the guest sees on the invoice. It is back (0007).
  Migrating without it would have discarded that text silently.

## Legacy backend: removed

`backend/` (Cloudflare Workers + D1, TypeScript) **has been deleted**. It ran the same API on
`http://127.0.0.1:8787`, so that port now belongs to the Go server. Its source is in git
history — recover it with `git show <deletion-commit>^:backend/<path>`, or check out the commit
before the removal. Local-only state (`.wrangler/`, `.dev.vars`) was gitignored and was copied
to `~/Documents/dombook-legacy-backup-<date>/` first; see `server/CUTOVER.md`.

What it still tells you: it was the behaviour the Go server had to match. Its rules were
subscription-shaped (`free | pro | business`, 1 place + 1 property), which the per-unit
licensing model replaced — see the licences section above. Its migration files are the source
of the D1 shapes that `internal/d1import` reads.

## Cloud auth (desktop login)

Desktop auth lives in `src/main/auth.cjs` and persists the JWT encrypted through
`src/main/auth-session.cjs`. `DOMBOOK_API_URL` selects the server (default
`http://127.0.0.1:8787`, which is now the Go server — start it with `go run ./cmd/api`). IPC is
exposed as `window.domBook.auth`. Login is required: a signed-out window shows only the OTP
login screen.

- The desktop **must not** write `accounts.plan`. A licence is an `account_entitlements` row,
  and the client has no route that creates one — see the licences section.
- A new colleague joins by invitation: an owner or admin posts to `/auth/invites`, the invited
  address becomes loginable, and their first sign-in attaches them to the account with the
  invited role. Implemented in `server/internal/api/invite_routes.go`; verified by
  `scripts/verify-invites.mjs` and `internal/api/invite_routes_test.go`.

## Running locally

- Server (Go + PostgreSQL, the target): see `server/README.md`. `createdb dombook_dev`, then `DOMBOOK_DSN=... go run ./cmd/migrate up`. Tests need `DOMBOOK_TEST_DSN`, otherwise the PostgreSQL integration tests skip instead of failing.
- **Run the Go tests as `go test -p 1 ./...`.** Integration tests share one test database, so parallel package processes fight over the schema. The helper detects this and fails with instructions, but the serial form is the correct command.
- To prove a test really catches a regression: mutate the schema, then `DOMBOOK_SKIP_MIGRATE=1 go test -p 1 ...` so the migrations do not silently repair it. Full recipe in `server/README.md`.
- Desktop: `npm start`, but **clear `ELECTRON_RUN_AS_NODE` first** (`env -u ELECTRON_RUN_AS_NODE npm start`). VS Code and other Electron-based terminals export `ELECTRON_RUN_AS_NODE=1`, which makes `require("electron")` return its path string instead of the API, so `src/main.cjs` dies at `app.setName(...)` with `Cannot read properties of undefined`.
- `/auth/setup` bootstraps the first owner account only while zero users exist; afterwards it needs `SETUP_TOKEN`. A local DB with a test user therefore cannot be re-bootstrapped — clear the `users` table to re-open setup.

## Tenant isolation (Go server)

Isolation is enforced in PostgreSQL, not in Go: every request transaction sets `app.tenant_id` and RLS policies filter on `current_tenant_id()`. The API connects as the unprivileged `dombook_app` role; ad**min**istration uses `dombook_admin` (BYPASSRLS). Never merge the two.

- An unset tenant yields **zero rows**, not everything. That is deliberate: missing data is loud, a leak is silent.
- Operations that run before a tenant exists (signup, login, session resolution by jti, invite lookup) cannot be authorized by tenant policies. Each gets a narrow `SECURITY DEFINER` function in `server/internal/store/migrations/20260811000004_*.sql` / `0005_*.sql`. The full list and the four rules for adding one are in `server/README.md`.
- `verification_codes` has RLS enabled and **no policy** (deny-all); its only access path is those functions. Do not "fix" it by adding a policy.
- One-time codes are consumed by a single `UPDATE ... WHERE used_at IS NULL`, which is what makes them single-use under concurrency. Do not split it into SELECT-then-UPDATE.
- Migrations that replace a function must drop the old form **by exact signature**: PostgreSQL keeps overloads and `DROP FUNCTION IF EXISTS <name>` fails on an ambiguous name.

## Auth flow (Go server)

`server/internal/auth` owns the passwordless login flow; it depends on a narrow `Store` interface, so decisions are unit-tested with a fake and SQL is covered separately by `store` integration tests.

- `/auth/send` must not reveal whether an address exists: a code row is written for unknown addresses too, so response shape and work are identical. Only `loginable` differs, and it is not an error.
- Two independent throttles on send (in-memory interval + window cap, plus a durable count in the database) and a failed-attempt lock on verify. `RateLimiter.Sweep` is the memory bound — pruning on access only cleans keys touched again, so a spray of one-shot addresses needs the explicit sweep.
- Codes are hashed at rest and burned by one conditional `UPDATE`; refresh tokens rotate per use, and replaying a consumed one revokes the entire family plus all sessions for that user. A family revoked deliberately (sign-out-everywhere) is rejected as an ordinary dead session instead, so the compromise path does not cry wolf.
- `Options.OnCodeGenerated` is a **test seam only** (the plaintext of a non-loginable address's code exists nowhere else). Keep it nil in production.
- The desktop client stores the old single JWT via `src/main/auth-session.cjs`; refresh tokens are server-side ready but not yet used by the client.

## Shared domain fixtures

`fixtures/*.json` at the repository root is the single source of truth for booking-policy and date-math rules, loaded by **both** suites: `tests/fixtures.test.cjs` (Node) and `server/internal/domain/policy_test.go` (Go). Assertions use stable error codes (`check_in_past`, `check_in_too_far`, `stay_too_long`), never localized prose. `go:embed` cannot reach a parent directory, so the files are copied into `server/internal/domain/testdata/`; a test fails if that copy drifts. After editing a fixture: `cp fixtures/*.json server/internal/domain/testdata/`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
