# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Layout and the commands that matter

Two stacks live in one repository, and it is worth knowing which one a change belongs to:

| Path | What it is |
|---|---|
| `src/main.cjs`, `src/main/` | Electron main process: IPC handlers, auth, sync client |
| `src/database.cjs` | The desktop domain layer on sql.js (in-memory SQLite + file persistence) |
| `src/renderer/` | Sandboxed renderer (`app.js`, `styles.css`, `i18n/`) — cannot `require` |
| `src/domain/booking/` | Booking-policy math shared with the server through `fixtures/` |
| `server/` | Go + PostgreSQL API. `server/README.md` is authoritative for it |
| `scripts/e2e-*.mjs` | Suites that drive the real app over CDP; `verify-*.mjs` check API contracts |
| `fixtures/` | Canonical domain cases both stacks must agree on (copied into Go testdata) |

Commands, from the repository root unless noted:

```bash
npm test                     # desktop unit suite: node --test tests/*.test.cjs
npm run test:smoke           # desktop smoke test against a temp profile
env -u ELECTRON_RUN_AS_NODE npm start   # the app; unset that var first, see "Running locally"
bash scripts/e2e-all.sh      # brings up the stack, then drives the real app over CDP

scripts/db.sh up             # the database, in Docker, with both databases created
scripts/check-all.sh         # every check: unit suites + build/vet/test/gofmt
scripts/check-all.sh --e2e   # ... plus the end-to-end suites
```

`npm run check` / `npm run check:e2e` / `npm run db:up` are the same commands.

There is **no linter or formatter configured** for the JavaScript (`gofmt` covers the Go). Match the
surrounding style by hand rather than introducing a toolchain.

Conventions that already hold across the codebase:

- Comments explain **why**, normally naming the failure they prevent. A comment restating the code
  is not the house style; one naming the bug it prevents is.
- Domain rules are asserted with stable machine codes (`check_in_past`, `rental_too_short`), never
  on localized prose.
- Test names state the behaviour (`"cancelling releases the nights"`), so a failure reads as a
  sentence about the product.

### Branding is a matrix, not a string

The product is **RentKeeper** (renamed from DomBook — see its own section below). One rename touched
every layer, and each layer holds the name differently:

| Layer | Authoritative value | Guarded by |
|---|---|---|
| Window, tray, installer, `appId`, userData dir | `package.json` `productName` + `app.setName()` | `scripts/e2e-branding.mjs` |
| Login heading and locales | `src/renderer/index.html`, `src/renderer/i18n/*.js` | `scripts/e2e-branding.mjs` (three locales) |
| Server's outgoing-message name | `APP_NAME`, defaulted in `server/internal/config/config.go` | `TestDefaultsAreSane` |
| Release artefacts | `.github/workflows/build-desktop.yml` | upload step fails on a missing path |

Change one row and the others go stale silently — which is exactly how the server default was left
saying `ДомБук` after the rename. When touching any of them, grep for the other three.

### CI

`build-desktop.yml` builds installers on a `v*` tag and runs `npm test` plus the smoke test on each
platform. `server.yml` runs build, vet and `go test -p 1 -race` against a `postgres:16` service.
That job exists because the integration tests **skip** without `RENTKEEPER_TEST_DSN`, and they are the
only thing that exercises tenant isolation — an unset DSN would leave RLS untested while every
check stayed green.

## Schema & ids

Desktop domain tables (places, properties, reservations, reservation_nights, reservation_services, reservation_meals, app_settings, audit_log) use **UUID TEXT ids** plus sync columns `created_at`, `updated_at`, `deleted_at`, `version`, `last_writer`, matching the server's baseline (minus `tenant_id` — the desktop is single-tenant; the server calls a property a `unit`). `version` starts at 1 and every write bumps it. Legacy integer-id databases are migrated in-place by `migrateLegacyIntegerIds()` (`src/database.cjs`), registered as migration `sync_schema_v1`; the old `ensureColumn` mechanism is kept for backward compatibility. New rows need an explicit `crypto.randomUUID()` id; `last_insert_rowid()` is gone.

## Licences & entitlements (Go server)

The paid tier is sold as a **three-month term** (`app_quarterly`, 90 days). It used to be a
one-time perpetual purchase; that SKU is withdrawn from sale but every grant already issued
stays valid **forever**, so `app_perpetual` must remain in the catalog and in the SQL allowlist
even though nothing sells it. The rules live in `server/internal/billing/catalog.go` — a SKU's
name, duration, what it unlocks, and whether it is still `Sellable`. `accounts.plan`
is a **legacy subscription column and no longer decides anything**; both the service check and the
database trigger read `account_entitlements` via `account_is_paid()`. Reading the plan column
anywhere would let a customer who paid once fall back to the free cap.

- **A SKU lives in TWO places, and they must agree.** `Catalog` in Go, and the hard-coded
  `e.sku IN (...)` allowlist inside `account_is_paid()` in SQL. Adding one to the catalog only
  means the service accepts the customer and the database trigger then refuses their write —
  the worst shape of bug, because it arrives at the moment of a write rather than a purchase.
  `TestEveryPaidSKULiftsTheCapInTheDatabase` iterates the catalog, grants each paid SKU and
  performs a real second-unit insert, so the next term added is covered without anyone
  remembering this. Adding a SKU means adding a migration; 0009 is the quarterly one.
- **Retire, never delete.** `Evaluate` ignores a SKU it cannot look up, so removing a catalog
  entry silently demotes paying customers to the free tier. `Sellable: false` is how a SKU
  leaves the shop; deleting the entry is how you revoke licences by accident.
- Perpetual is `expires_at IS NULL`, not a far-future date.
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
- **`RENTKEEPER_SKIP_MIGRATE=1` is required in production.** The API runs as `rentkeeper_app`, which
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
`src/main/auth-session.cjs`. `RENTKEEPER_API_URL` selects the server (default
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
heading in all three locales, menus, tray label, installer artefacts, `appId`, the userData
directory, the Docker container and databases, the database roles, and every environment
variable.

**Four identifiers keep the old name ON PURPOSE, because a rename would break something that
already exists.** They are not oversights, and "fixing" them is a regression:

| Kept | Why renaming it breaks something |
|---|---|
| `dombook-desktop` | The Electron userData directory. Electron derives it from the app name, so every existing user's database, backups and encrypted session live under it. `migrateLegacyUserData()` moves it only when the new directory is absent. |
| `dombook.sqlite` | The database filename inside that directory. Settings shows the real name, whatever it is. |
| `github.com/inajaf/dombook/server` | The Go module path, i.e. the repository URL. Renaming it rewrites an import in every server file and breaks anything that imports it. |
| `dombook_app` / `dombook_admin` | Database roles. Roles are cluster-level: migration 0010 adds the new names and deliberately does NOT drop these, because dropping them would revoke access for databases the migration never runs against. An operator removes them after switching DSNs. |

The old `DOMBOOK_*` environment variables and the legacy `AUTH_EXPOSE_CODE` spellings also keep
working as fallbacks — see `config.envFallback`. They are documented as legacy, not as the name
to use.

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

`scripts/e2e-all.sh` brings up the stack and drives the actual Electron app over CDP — 93
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

### The cancel block: a cascade that hid its own cause

`e2e-operations.mjs` failed once in a full `e2e-all.sh` run, with FOUR consecutive checks red
from *"a second booking exists"* onward, and passed every other time. Two defects in that block
made the failure unreadable, and both are fixed:

- **The unit creation was never checked.** The block created `Отмена-<stamp>` and returned
  `unit.data?.id` without looking at `unit.ok`, so a failed create produced `undefined`, the
  booking below failed, and the three checks after it failed with it. One discarded error
  presented as four product bugs. There is now a check on that create that prints its error,
  the entitlement allowance, the place id and how many rows carry the new name.
- **The dates were fixed offsets** (`today+10..today+12`), the last such block in the file and
  the one pattern the section above warns about. The window now comes from live occupancy, the
  same way the earlier check-in block finds its dates.

Both refusal modes were then induced against the running app to confirm the diagnostics
separate them:

| Cause | Error the suite now surfaces |
|---|---|
| the unit is not there | `Дом: неверный идентификатор` |
| the unit is there, the dates are refused | `Заезд можно оформить максимум на 21 день вперёд — до <date>` |

**The original failure was never reproduced** — 5 isolated runs and 4 full `e2e-all.sh` runs, 9
in total, all green. So this is a diagnosed hardening, not a confirmed fix: whatever produced
the unit-creation failure is still unexplained. Do not re-broaden it into a hunt without that
output in hand — it now names the cause on the spot instead of cascading, which is the point.

**The entitlement cap was ruled out, and the counter-evidence is worth keeping.** The first
hypothesis was that the free tier's 1-unit cap refused the create. It cannot have: there is no
gate to refuse it. `unitAllowance`/`unitAllowanceStatus` only *report*, `createProperty` never
reads them, and the renderer's only use is an upgrade banner (`overLimit`). The measurements say
the same — an account holding **3 active units on an allowance of 1** (`over: true`) shows three
units existing and not one write refused. That is the documented design (the server owns
enforcement so a licensed user offline is never locked out), so a unit-cap refusal is not a
candidate for any e2e failure in this project.

## Visual defects found by looking at the app

Two layout faults that no assertion would have caught, both found by reading screenshots:

- **`.empty-state { display: grid }` beat the `hidden` attribute.** A UA `[hidden]` rule has no
  specificity over a class, so four elements stayed on screen while the renderer believed they
  were hidden: "Бронирований пока нет" above a table that HAD a booking, "Добавьте первый
  объект" above three existing properties, and two nav badges showing "0". Fixed with
  `[hidden] { display: none !important; }`. The attribute is used all over the renderer, so
  that one rule is what makes any of it work.
- **The calendar grid squeezed instead of scrolling.** `minmax(64px, 1fr)` inside a narrower
  container collapsed the day columns below their minimum and clipped the last one mid-header,
  with no way to reach it. The grid now sizes from `--calendar-days`, which the renderer sets,
  so it overflows into the scroll container instead. 15 header cells, all reachable.

Vision is worth running over the main screens after UI work; both of these were invisible to
92 passing checks. (The suite is 93 now; both of these were found at the 92-check revision.)

### How to actually look at the app

The `vision_*` tools (`vision_glance`, `vision_ground`, `vision_detect`, `vision_crop`,
`vision_trace`, `vision_pixel_diff`, `vision_long_screenshot_ocr`, `vision_extract_foreground`,
`vision_dominant_colors`, `vision_html_screenshot`) come from the DSH plugin
`@anionex/dsh-vision-toolkit`. Call `vision_toolkit_activate` once to expose them.

- **Coordinates are ORIGINAL image pixels**, so a `vision_ground` box feeds straight into
  `vision_crop` with no scaling in between.
- **Artifacts are written into the session workspace** under `.dsh-vision-toolkit/`, which is
  gitignored. Deleting that directory is always safe.
- **The provider is DeepSeek** (`deepseek-flash`, the only vision-capable model on that key),
  configured in `~/.dsh/profiles/web/cordis.patch.yml`, with the key held as the DSH credential
  `VISION_API_KEY`. The plugin's own default is a free public endpoint that answers HTTP 429
  under any real use, so if vision starts failing with a rate limit, that default is back —
  meaning the profile config was lost.
- **The plugin is version-exempt, and the exemption is keyed to the exact DSH version.** It is
  published for DSH `<0.2.0` while this machine runs a 0.2.x alpha, so DSH loads it only
  because an explicit exemption was granted. **A DSH upgrade invalidates it** and the tools
  stop loading. Repair with `~/.dsh/vision-setup.sh` (`--status` to check only; idempotent),
  then restart DSH.

The older `dsh-glance` / `dsh-ground` / `dsh-detect` / `dsh-crop` shell commands are gone: they
wrapped a different, now-removed plugin. Use the `vision_*` tools.

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

**The database is a Docker container, started with one command.** `scripts/db.sh up` creates
it and both databases. Everything else — the server, migrations, Go tests, the e2e suites —
reads its host, port and credentials from `scripts/db-env.sh`, which is the single place that
decides them.

- **The container is on 55432, not 5432**, because a Homebrew PostgreSQL is often already
  bound there. Never hardcode either: source `scripts/db-env.sh`, or `require` nothing and
  read `RENTKEEPER_DB_HOST`/`RENTKEEPER_DB_PORT`. A script that assumes a port is how a suite ends
  up testing a different database than the server writes to — which presents as a product bug.
- Go tests need `RENTKEEPER_TEST_DSN`, otherwise the PostgreSQL integration tests **skip instead
  of failing**. CI must set it or tenant isolation goes untested; `scripts/check-all.sh` sets it.
- **Run the Go tests as `go test -p 1 ./...`.** Integration tests share one test database, so
  parallel package processes fight over the schema. The helper detects this and fails with
  instructions, but the serial form is the correct command.
- Migrations run as the **database owner** (`rentkeeper` in the container). Migration 0003's
  `ALTER DEFAULT PRIVILEGES` binds to the role that runs them, so a different one silently
  stops granting the application role access to new tables.
- To prove a test really catches a regression: mutate the schema, then
  `RENTKEEPER_SKIP_MIGRATE=1 go test -p 1 ...` so the migrations do not silently repair it. Full
  recipe in `server/README.md`.
- Desktop: `npm start`, but **clear `ELECTRON_RUN_AS_NODE` first** (`env -u ELECTRON_RUN_AS_NODE npm start`). VS Code and other Electron-based terminals export `ELECTRON_RUN_AS_NODE=1`, which makes `require("electron")` return its path string instead of the API, so `src/main.cjs` dies at `app.setName(...)` with `Cannot read properties of undefined`.
- `/auth/setup` bootstraps the first owner account only while zero users exist; afterwards it needs `SETUP_TOKEN`. A local DB with a test user therefore cannot be re-bootstrapped — clear the `users` table to re-open setup.

## How to work in this repository without being asked twice

The instruction is a task or a feature, not a procedure. Everything below is expected to be
done without asking, because asking for each step is slower than the work itself.

**Do these without asking:**

1. Read the relevant code before changing it. This file and `server/README.md` carry the
   sharp edges; the code carries the conventions. Both beat guessing.
2. Work in small verified steps. Change one thing, run the checks that cover it, then continue.
   `scripts/check-all.sh` runs everything; `--e2e` adds the real-app suites.
3. **Add or update tests with every behaviour change.** A fix without a regression test is a
   fix that will come back. When a rule changes, change the test that pins it in the same
   commit, and say why in a comment.
4. Fix what the work exposes. A stale comment, a doc that now lies, a test that could never
   have failed (see the cancel-block section) — repair it as part of the change.
5. Leave evidence. Report the exact commands run and their real results, including failures.
   A claim that is not backed by a command in the transcript is not a result.
6. Commit in reviewable pieces with messages that explain *why*, on a branch, and open a PR.
   Describe the limitation you did not fix as plainly as the thing you did.

**Stop and ask first for:**

- **Anything that changes what a customer paid for.** Licences, entitlements, quotas, prices,
  and the database's `account_is_paid()` allowlist. Getting this wrong takes access away from
  someone who paid; a wrong guess here is worse than a delay.
- **Destructive or shared-state actions**: dropping or migrating production data, force-pushing,
  rewriting published history, merging to `main`, deleting a volume or an AVD, changing CI secrets.
- **Deleting a plan or a product option that was not named in the task.** Replacing one SKU is
  a decision about that SKU; removing others that merely look redundant is a separate decision
  that was not made. Do the named thing and say what else you noticed.
- **Irreversible schema changes to data that exists**, as opposed to adding to it.

**Never:**

- Weaken, skip or delete a test to make a suite pass. If a test is wrong, fix the test and say
  so in the commit; if it is right, the code is wrong.
- Claim a check passed that did not run, or hide a failure behind "flaky". An intermittent
  failure is a finding: reproduce it, instrument it if you cannot, and document what you learned.
- Leave the machine or the working tree in a state the next person has to clean up: stop
  servers you started, drop the throwaway database, delete probe files, and leave no stray
  processes. `git status` is expected to be clean of debris when you report.

## Tenant isolation (Go server)

Isolation is enforced in PostgreSQL, not in Go: every request transaction sets `app.tenant_id` and RLS policies filter on `current_tenant_id()`. The API connects as the unprivileged `rentkeeper_app` role; ad**min**istration uses `rentkeeper_admin` (BYPASSRLS). Never merge the two.

- **The roles are named after the product** (`rentkeeper_app` / `rentkeeper_admin`, created by
  migration 0010). `dombook_app` / `dombook_admin` are NOT dropped and must not be: roles are
  CLUSTER-level, so a migration that dropped them would revoke access for every database on the
  server, including ones it never runs against, and would break a deployment whose DSN still
  names them. An operator switches the DSNs and then removes them once nothing authenticates as
  them. Two roles can hold the same privileges; only one of them is ever the answer to “who may
  read tenant data”, and that is `rentkeeper_app`.
- **A renamed role needs its FUNCTION grants, not just its table grants.** 0010 granted schema and
  table privileges and the suite immediately failed with `permission denied for function
  bootstrap_account`: the SECURITY DEFINER functions each hold their own EXECUTE grant, made
  per-function on purpose. Grant them explicitly; `GRANT EXECUTE ON ALL FUNCTIONS` would undo the
  rule that a privileged function is reachable only where someone allowed it.
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

Desktop talks to the SaaS backend over plain Node `fetch` (no network lib) via `src/main/auth.cjs` (`createAuthApi`) with a `safeStorage`-encrypted JWT persisted by `src/main/auth-session.cjs` to `<userData>/auth-session.bin`. API base URL defaults to `http://127.0.0.1:8787` (override with `RENTKEEPER_API_URL`). IPC channels are `auth:status|send|setup|verify|setPlan|logout` wired in `src/main.cjs` and exposed to the renderer as `window.domBook.auth` (see `src/preload.cjs`). Login is **required**: there is no offline escape hatch — the renderer gates all app data behind a restored session; a signed-out window shows only the login screen. After a successful OTP verify the renderer shows a plan picker (free/business); selecting business calls `auth:setPlan` → `PATCH /account/plan`, which ships with the phase-2 subscriptions backend (the running local API returns 404 — the desktop still wires the call and surfaces a friendly message, keeping free). In dev the backend sets `AUTH_EXPOSE_CODE=true` so `/auth/send` echoes the OTP in the response; the login UI surfaces that code, production relies on email delivery. Backend contract is authoritative in `docs/saas-spec.md` §4.1/§5.1.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
