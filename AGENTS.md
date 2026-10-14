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

## Client/server parity

The desktop and the server must judge a booking by the same rules, and a client-side rule that
is never given the account's real configuration is the failure mode to watch for.

- The server owns `today` and the booking window; the client caches both and validates against
  the cache. `src/database.cjs` passes `policy: this.bookingPolicy()` into `assertBookingDates` —
  omit it and the client silently applies the compiled 21-day default while the server accepts
  the booking, so the user is refused a booking they are entitled to make. Gated by
  `tests/entitlements.test.cjs` and `scripts/verify-policy-parity.mjs`.
- **`upsertSetting` writes only to the in-memory database.** Every caller must call `persist()`
  itself, or the value is lost on restart. `setBookingPolicy`, `setEntitlements`, and
  `ensureDeviceId` all do; `setLanguage` already did. A cache that does not survive a restart is
  useless exactly when it is needed — offline, on a licensed device.

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

## The renderer is sandboxed (desktop)

`src/renderer/app.js` runs with `sandbox: true` and cannot `require` anything. It must not
reimplement a rule that also lives in the shared domain module — that is the drift
`fixtures/*.json` exists to prevent.

- When a screen needs a computed domain value, compute it in `src/main.cjs` and send it over
  IPC. The rentals page reads `rental_months`, computed in the main process, for exactly this
  reason.
- **`form.reset()` leaves `<select>` elements UNSELECTED** (`selectedIndex === -1`), and
  assigning a value that is not among the options leaves them unselected too. On a `required`
  select, submit then does *nothing at all* with no error shown. Set `selectedIndex`
  explicitly, and make sure a default id comes from the list actually offered — a dialog that
  filters its options must not default to an entry it filtered out.

## Sync: what it takes for a change to reach the server

Sync had NEVER been observed to succeed before `scripts/e2e-sync.mjs` existed. Every fault
below failed the push outright, and each was invisible to both unit suites:

- **Nights must be queued, not just the booking.** `insertNights` wrote rows directly and never
  called `enqueueSync`, so a booking reached the server with no nights and every other device
  showed the unit as free for the whole term.
- **`has_food_service` is an integer locally and a boolean on the server.** pgx cannot encode a
  Go int as bool: the push failed with "unable to encode 0 into binary format for bool". A SQL
  cast does NOT help — the failure is while ENCODING the parameter, before the cast.
  `toRemote` coerces the columns in `BOOLEAN_COLUMNS`.
- **The payload must be in dependency order.** It is built from a JS object, and relying on key
  order is intermittent. `SYNC_ORDER` mirrors the server's `SyncTables`.
- **A `jsonb` column arrives parsed.** `conflict_details` came back as an object where the local
  column is TEXT, and sql.js cannot bind an object — "tried to bind a value of an unknown type
  ([object Object])". `toLocalValue` normalises objects and booleans on the pull path.
- **The local schema must accept what the server sends.** It had no `conflict_code`,
  `conflict_details` or `resolved_at`, and its status CHECK excluded `'conflict'`. The first
  pull threw "table reservations has no column named conflict_code", forever. SQLite cannot
  alter a CHECK, so `rebuildReservationsForConflictStatus` rebuilds the table and its three
  child tables, preserving every row and its version.
- **A refused push must NOT be followed by the pull.** Applying server rows deletes their
  outbox entries — correct when the push succeeded, catastrophic when it was refused: the
  local edit is overwritten by the server's older copy AND its queue entry is deleted, so the
  user's change is gone from both sides. The pull is now skipped while any row is unconfirmed.
- **A permanently refused row must not block the rest.** The server marks a row retryable only
  when retrying could help (a parent has not been pushed yet). Rows it will never accept — over
  the plan allowance, or refused by the schema — are counted as `stuck` and left queued rather
  than holding the account's other data hostage.
- **Each row needs its own savepoint.** A refused INSERT aborts the whole PostgreSQL
  transaction, so one bad row took the entire push with it: "current transaction is aborted".
- **The demo seed must fit the free tier.** It created one place and THREE units against a cap
  of one place and one unit, so a new free user's first push was refused by the entitlement
  trigger. It now seeds one place and one unit — a sample that cannot leave the device is worse
  than no sample.

## The IPC authentication gate (desktop)

Hiding the workspace behind the login screen is presentation, not security. Every IPC channel
except `SIGNED_OUT_CHANNELS` in `src/main.cjs` requires a session; without that, `places.list`
and `places.create` both answered while signed out. Gated by `tests/ipc-gate.test.cjs`, which
fails if a data channel is allowlisted or an allowlisted channel is misspelled.

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

## The product is RentKeeper

Renamed from DomBook ("дом" + "book" read as "house book", which suggested a static record
rather than rental management). **RentKeeper** names what the app does: rents, kept in order.
It covers both nightly bookings and monthly tenancies, which is why the name is not
stay-specific.

The rename is complete in everything a user sees — window title, both brand marks, the login
heading in all three locales, menus, tray label, installer artefacts, `appId`, and the
userData directory. `tests/` and `server/internal/domain/testdata/` still say `dombook` in
paths and DSN names deliberately: those are internal identifiers, and changing them would
break existing installs and CI for no user benefit.

- **`migrateLegacyUserData()` in `src/main.cjs` is load-bearing.** Electron derives the
  userData path from the app name, so the rename moved where the app looks for its database,
  logs and encrypted session. Without the migration every existing user opens the renamed app
  and finds it empty — their bookings, licence and login apparently gone. It moves
  `dombook-desktop` to `rentkeeper-desktop` only when the new directory does not exist.
- The SQLite file is still called `dombook.sqlite`. It lives inside the userData directory,
  which the migration carries over, so renaming the file too would mean rewriting every
  existing install's path for no gain. Settings shows the real name, whatever it is.
- `RentKeeperLocales` and `RentKeeperDatabase` replaced the old global/class names.

## End-to-end suites (real app, real database)

`scripts/e2e-all.sh` brings up the stack and drives the actual Electron app over CDP — 92
checks across six suites. These exist because every serious bug in this project was invisible
to both unit suites:

- **`e2e-scenarios.mjs`** — signup, the plan step, a guest house and a unit.
- **`e2e-booking.mjs`** — a stay through the dialog, its nights on the calendar, overlap
  refused, back-to-back allowed, capacity enforced.
- **`e2e-branding.mjs`** — the product name as rendered, in three locales and both windows.
- **`e2e-operations.mjs`** — check-in, early checkout, cancel, delete, archive/restore, backup.
- **`e2e-security.mjs`** — two tenants; neither can read, write or book into the other's data,
  and the signed-out bridge refuses everything.
- **`e2e-sync.mjs`** — a real push and pull, with the nights confirmed in PostgreSQL.

### Writing one: the traps, all of which cost real time here

- **Use `freshStart(appHdl)`, never `resetAuthState()` alone.** The app holds its database in
  memory and rewrites the file on exit, so deleting the profile under a running app leaves the
  old data on disk moments later. `freshStart` stops the app, waits for the CDP port to free,
  clears the server AND the profile, then starts a new app.
- **The server keeps the previous run's data.** `resetAuthState` truncates `users, accounts, …`
  `CASCADE`, which reaches the tenant tables through their account FK. Clearing only the auth
  tables leaves the old bookings on the server; the fresh client pulls them back down and its
  rows then collide — a booking refused as "already occupied" by a row the suite never created.
- **Never reuse fixed date offsets.** The operations suite derived `today+2..today+5`, and a
  leftover row from an earlier run made a correct booking look broken. It now picks the first
  free window from live occupancy and re-reads the booking's real dates for every later step.
- **Each suite creates its own place and unit, timestamped**, rather than sharing the demo seed.
- **The renderer caches the unit list.** A unit created through the bridge is invisible to a
  dialog until `refreshCore()` runs, exactly as the app does after a form submit. Skipping it
  leaves a required `<select>` with no matching option, and the submit silently does nothing.

## Long-term rentals

A tenancy is a reservation with `booking_kind = 'rental'` and a long date range, so the one
existing `reservations_unit_no_overlap` exclusion constraint covers nightly and monthly lets
alike. That is the whole design: a second inventory or a second availability check would
reintroduce a way for the two modes to disagree.

- `booking_kind` is **stored, not derived** from length — an owner may agree a monthly rate on
  a three-month let.
- A tenancy is priced by whole **calendar months** (`wholeMonthsBetween`), never by nights x a
  nightly rate. Multiplying a nightly rate by 365 gives a number that looks like a year's rent
  and is not one.
- A tenancy shorter than one month is refused (`rental_too_short`). Its month count is zero,
  and zero months of rent is a free let rather than a small charge.
- Tenancies are exempt from the advance window and bounded by `maximumTenancyMonths` instead.
- `MaxNightCount` (1096) must stay above the longest permitted tenancy (24 months = up to 731
  days); a test compares the two.

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

## Cloud auth (Phase 1 desktop login)

Desktop talks to the SaaS backend over plain Node `fetch` (no network lib) via `src/main/auth.cjs` (`createAuthApi`) with a `safeStorage`-encrypted JWT persisted by `src/main/auth-session.cjs` to `<userData>/auth-session.bin`. API base URL defaults to `http://127.0.0.1:8787` (override with `DOMBOOK_API_URL`). IPC channels are `auth:status|send|setup|verify|setPlan|logout` wired in `src/main.cjs` and exposed to the renderer as `window.domBook.auth` (see `src/preload.cjs`). Login is **required**: there is no offline escape hatch — the renderer gates all app data behind a restored session; a signed-out window shows only the login screen. After a successful OTP verify the renderer shows a plan picker (free/business); selecting business calls `auth:setPlan` → `PATCH /account/plan`, which ships with the phase-2 subscriptions backend (the running local API returns 404 — the desktop still wires the call and surfaces a friendly message, keeping free). In dev the backend sets `AUTH_EXPOSE_CODE=true` so `/auth/send` echoes the OTP in the response; the login UI surfaces that code, production relies on email delivery. Backend contract is authoritative in `docs/saas-spec.md` §4.1/§5.1.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
