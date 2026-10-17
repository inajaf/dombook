# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Layout and the commands that matter

Two stacks live in one repository, and it is worth knowing which one a change belongs to:

| Path | What it is |
|---|---|
| `src/main.cjs`, `src/main/` | Electron main process: IPC handlers, auth, sync client |
| `src/database.cjs` | The desktop domain layer on sql.js (in-memory SQLite + file persistence) |
| `src/renderer/` | Sandboxed renderer — cannot `require`. Entry `js/app.js`; see the module map below |
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

## The renderer is a module graph with no bundler

`src/renderer/js/` is ES modules loaded by `<script type="module">`, which works over `file://` in
this Electron version — verified before the split depended on it, because the alternative (a custom
protocol to serve the renderer) is a much larger change. **No build step, no transpiler: the file
the browser loads is the file in the repository.**

| | |
|---|---|
| `js/app.js` | the shell: routing, redrawing, the login flow, boot |
| `js/api.js` | everything the page asks the outside world for, including the browser demo |
| `js/store.js` | the state object and the page labels |
| `js/formatters.js` | values to words and numbers — pure, no DOM, no state |
| `js/dom.js` | `$`, `$$`, `escapeHtml`, `icon`, `setBusy`, `showError` |
| `js/theme.js` | the theme and text-size switches |
| `js/toast.js`, `js/modal.js` | the message with an action, and the confirmation |
| `js/runtime.js` | the seam a view uses to ask the SHELL to redraw |
| `js/views/*.js` | one module per page: `calendar`, `dashboard`, `reservations`, `properties`, `rentals`, `conflicts`, `settings` |
| `js/theme-boot.js` | the ONE classic script, in `<head>`: a module is deferred, so a module would paint the window light and then turn it dark |

- **A view never imports the shell.** The shell imports the views to draw them; the other direction
  is a cycle, and a cycle's failure mode is a half-initialised module rather than an error. A view
  that needs a redraw calls `runtime.refresh()`; the shell fills `runtime` in at boot
  (`connectShell`). Keep it one-way.
- **A missing import is not a build error here.** It is a `ReferenceError` at the moment that line
  runs, and only then. Three shipped during the split: `$` in `toast.js` (so the message reporting a
  failure was itself the failure), `api` in `views/properties.js` (so saving a unit did nothing),
  and `statusLabelsFor` in `views/conflicts.js`, which never existed anywhere — a missing EXPORT is
  worse still: the browser refuses to link the graph and the window is blank. `tests/module-graph.test.cjs`
  now fails on both: a name a sibling exports that this file did not import, and an import that its
  target does not export. It is deliberately narrow — a general unresolved-identifier linter written
  with regular expressions reports parameters and destructuring targets as errors, and a test nobody
  trusts is worse than no test.
- Exports are computed from what OTHER files reference, so a module's surface is what it actually
  lends out rather than everything it happens to define.

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

## Flexible pricing (seasons, discounts, negotiated amounts)

A unit's price is no longer two constants. It is a base nightly rate, a monthly rate, and a small
rule set stored as JSON text on the unit row (`units.rate_rules` / `properties.rate_rules`):

```json
{"seasons":[{"name":"Новый год","from":"2026-12-25","to":"2027-01-10","nightlyRateMinor":48000}],
 "stayDiscounts":[{"minimumNights":7,"percent":10}],
 "tenancyDiscounts":[{"minimumMonths":12,"percent":10}]}
```

- **The rules live in `src/domain/booking/pricing.cjs`, mirrored in
  `server/internal/domain/pricing.go`, pinned by `fixtures/pricing-cases.json`.** Same rule as
  every other domain calculation in this project — the server prices a booking too (a reservation
  arriving over REST is recomputed from the unit), so one stack charging a season rate the other
  does not know about is a booking repriced behind the user's back.
- **Writing is strict, reading is forgiving.** `validateRateRules` refuses overlapping seasons,
  because the price would then depend on the order of a list nobody can see in the editor.
  `parseRateRules` NEVER throws: it drops what it cannot price and falls back to the base rate. A
  unit whose rules cannot be read must still be sellable — refusing the booking would turn one
  malformed settings row into a calendar nobody can use.
- **A season is a range of NIGHTS.** `to` is the check-in date of its last night, so a stay that
  checks out on the morning after `to` still paid the season rate for that night. The other
  convention makes the owner subtract a day in their head.
- **Discounts do not stack.** The largest threshold the booking reaches wins. Stacking produces a
  12-month let that triples a "10% for a year" rule, and it is invisible until an invoice is wrong.
- **Rounding is half-up on integer minor units** (`floor((amount * p100 + 5000) / 10000)`), never
  a float percentage. Go's float64 and JavaScript's Number disagree on some .5 boundaries.
- **The amount carries its working.** `reservations.rate_breakdown` stores the nights, the season
  rates that applied and the discount. Recomputing it on read would explain an amount charged
  months ago with today's prices. A negotiated amount stores `{}` — there is no working to show
  for a figure that was agreed rather than calculated.
- **The dialog's price is a QUOTE from the main process** (`pricing:quote`), never arithmetic in
  the renderer. The renderer is sandboxed and cannot load the module, and a second copy in the
  view is exactly the drift the fixtures exist to prevent. Quotes carry a request id so the slower
  of two keystrokes cannot overwrite the newer one.
- **A typed amount is a negotiated amount**, and it is sent only when it was typed. Sending the
  displayed value unconditionally would make every booking negotiated and freeze it against later
  rule changes. `submitReservation` spreads `accommodationMinor` in only while
  `state.accommodationManual` is set.
- **Early checkout is repriced through the same quote.** It used to charge nights x the BASE rate,
  silently refunding a peak-week surcharge for nights the guest actually stayed; a tenancy cut
  short was charged its monthly rate times its NIGHTS, which is a number that looks like rent and
  is not one. It is now whole months elapsed, flooring at one month.
- **Adding a column to the sync allowlist means adding it to the migration too.** The sync
  sanitizer iterates `syncColumns`, so a payload key that is not listed is not rejected — it is
  never written, silently. `rate_rules` and `rate_breakdown` are TEXT on both sides and not
  `jsonb`, so the value round trips byte for byte; a jsonb column comes back re-serialised and the
  client compares the pulled value against what it stored to decide whether a row changed.
- **The REST unit endpoints do not expose the rules yet.** A unit created through them gets the
  empty rule set, and an update leaves the stored rules alone. The desktop is a sync client, so
  nothing in the product is affected; a future web client editing rules would need the plumbing.

## Access between accounts (invitations)

Isolation is the default and is enforced in PostgreSQL. **The only way access is granted is an
invitation created by the account itself**, from Настройки → «Доступ к аккаунту» — which is what
the owner asked for in those words: another account sees nothing of this one unless this one
opens the door.

- **`GET /account/members` is for every member; the invitation routes are owner/admin only.** Who
  you work alongside is not administration; who may be invited is. `RequireRole("owner", "admin")`
  is the server's decision, never the client's — the panel hides the form when the list answers
  403, and that is presentation, not the control.
- **An invitation is bound to one email address and is what makes it loginable.** An address
  nobody invited cannot sign in at all (`loginable: false`), and `/auth/verify` turns a pending
  invitation into membership on that address's first sign-in.
- **An invitation can never grant `owner`** — `create_login_invite()` enforces that in the
  database, so an invite that could grant ownership cannot exist even if a handler were wrong.
- **It works only for an address with no user yet.** An existing account signing in is treated as
  "Existing member" (`server/internal/auth/service.go`) and lands in its own account; the
  invitation is ignored. Giving an ALREADY EXISTING account access to another would need
  memberships (one login, several accounts) — a change to how a session picks its tenant, not a
  new route. Not built.
- `e2e-security.mjs` holds the whole contract as assertions: nothing gets in before the grant, the
  colleague signs in and lands in the inviting account, they see the inviter's data, they cannot
  invite anyone else, and a revoked invitation closes the address again.
- **A test that takes a token from account creation and uses it later will get a 401**: clicking
  "sign out" calls `RevokeUserSessions`, which kills every session for that user, including the
  one an API client is holding. And re-signing in is not a workaround — `/auth/send` is throttled
  per address, and the window outlasts a 45-second wait. Take the token where you use it.

## Printed documents (contracts and invoices)

`src/main/documents.cjs` builds the HTML for two documents; `src/main/pdf.cjs` renders it to PDF
through an offscreen `BrowserWindow` and `printToPDF`; `src/main.cjs` owns the IPC. No PDF library
is involved — the browser engine that ships with Electron lays the page out, so what the owner
prints and what the file contains cannot drift apart.

- **A contract and an invoice are different documents for different readers.** The contract states
  the parties, the term, the rent, the deposit and the meter readings, and carries a signature
  block. The invoice lists what was charged, the discount, what was received and what is
  outstanding — the document an accountant or a tax inspection reads. A tenancy is offered both; a
  nightly booking is offered the invoice only, because a "договор найма" for two nights would
  state a monthly rent and a term that do not exist.
- **The figures come from the stored row, never from today's rates.** A document that re-prices
  last March's let with this year's season is the one failure a tax document cannot have. The
  season lines and the discount come from `reservations.rate_breakdown`.
- **`documentNumber` is DERIVED, not counted**: `<booking date>-<first 4 of the id>`. A counter has
  to be persisted, and a number that changes when a document is regenerated — or that two devices
  disagree about — is worse than a slightly ugly one.
- **The requisites live in `app_settings` as one JSON blob** (`document_requisites`), not as
  columns on an account: the set of details a jurisdiction wants varies, and a schema with one
  column per field would need a migration per country. They are editable in Settings, and a
  document is still produced without them — with blank lines rather than an error.
- **The month count is derived from the dates** (`wholeMonthsBetween`). `rental_months` is attached
  by the IPC layer when it LISTS reservations and is absent from a single fetched row, which is how
  a twelve-month lease printed "(0 мес.)".
- **The pages are laid out in a font that ships with the app, not in one the machine has.**
  `build/fonts/LiberationSerif-{Regular,Bold}.ttf` (SIL OFL 1.1, licence and provenance in
  `build/fonts/README.md`) are named by `@font-face` and addressed with an absolute `file://` URL,
  because the document is written to a temp file and loaded from there — a relative URL resolves
  against the temp directory. Liberation Serif is metric-compatible with Times New Roman, so the
  line breaks and the page count did not move. The stack used to be
  `"Times New Roman", Georgia, serif`: Times New Roman does not exist on a stock Linux, Chromium
  substituted another serif with different advances, and the page-count assertion in the suite was
  really an assertion about the machine's fonts. **`build.files` is an allowlist** and did not list
  `build/fonts` — a packaged app would have shipped without the font and printed in whatever serif
  the user had, which a checkout cannot show. `tests/documents.test.cjs` now resolves the emitted
  URL to a file that exists and checks the packaging pattern, and with the font embedded the
  contract went from 153 KB (7 subsets, 88% of it font streams) to 37 KB (2 subsets).
- **`preferCSSPageSize` is left unset.** A two-page contract came out as a single page once, with
  the clauses and the signature block simply absent, and the file was a valid PDF that opened
  normally and ended mid-sentence. It has **not been reproduced** — 20 generations since, with and
  without the flag, all produced two pages — so the 200 ms settle before `printToPDF` is a
  mitigation for an unexplained truncation, not a fix for a diagnosed one.
  **`scripts/e2e-documents.mjs` asserts a page count for exactly this reason**: a truncated PDF
  passes every other check there is, including "the file is a PDF" and "it is not empty".

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

## How agents work here (the four conditions)

`docs/agent-workflow.md` is the full protocol. The parts that are rules rather than advice:

1. **Runtime verification, not a report.** Ten e2e suites build, install, launch and drive the real
   app over the DevTools Protocol. A claim with no command, log, screenshot or count behind it is
   not a result. Every serious defect in this project's history was invisible to the unit suites
   and visible here.
2. **Two loops.** The inner loop is the author with `scripts/check-all.sh`. The outer loop is
   coordination plus independent audit — `scripts/verify-branch.sh` and
   `scripts/merge-verified.sh`. A writer does not verify their own work.
3. **The codebase is the memory.** A repeated mistake becomes a check in the repository, in the
   same commit that fixes it — never a line in a document somebody has to remember. The table in
   `docs/agent-workflow.md` lists what each past defect became.
4. **The author does not merge their own pull request.** Verification runs in a CLEAN worktree of
   the commit, the verdict is a file bound to that sha, and the merge gate refuses without one.

```bash
scripts/check-all.sh --e2e          # inner loop: this working tree
scripts/verify-branch.sh <sha>      # outer loop: a clean copy, produces artifacts/verdict-<sha>.json
scripts/merge-verified.sh <pr>      # refuses without a passing verdict for the PR's exact sha
```

- **A commit on `main` is refused by `.githooks/pre-commit`.** Committing to main happened twice
  here — once by a person, once by an agent that had just merged and did not check where it was
  standing — and both times the work had to be moved afterwards, through a `reset` that could have
  taken uncommitted changes with it. `npm install` installs the hook (`postinstall`); the override
  is `RENTKEEPER_ALLOW_MAIN_COMMIT=1`, which is deliberately verbose.
- **Do not run `git reset --hard` with uncommitted work.** It destroyed an afternoon of this
  session's changes once, and the recovery was luck: `npm run build:web` had copied the renderer
  into `release/web` minutes earlier.
- `tests/agent-workflow.test.cjs` runs the hook and the merge gate in a throwaway repository, so
  the guards cannot rot into decoration.
- **`main` is protected on GitHub and the required check is the one that runs the e2e suites.**
  Runtime verification is therefore not a thing an agent may skip: the ten suites launch the real
  app and drive it over the DevTools Protocol in CI, and a merge into `main` cannot happen without
  them. `enforce_admins` is on, so this binds the owner too. Reversible with
  `gh api -X DELETE repos/inajaf/dombook/branches/main/protection`.

## How `database.cjs` was split, and what it taught

Finished. The file went from 2024 lines to 1048, and what is left is the storage primitives plus the
domain commands. This section stays because the method generalises, and because two of its lessons
cost a round each.

The groups now living under `src/domain/`: `migrations.cjs` (schema and the pre-UUID rebuild),
`reports.cjs` (everything a screen reads), `settings.cjs` (booking policy, language, licence cache),
`backups.cjs` (the files and their limit), `clock.cjs` and `fields.cjs` (two helpers both layers
needed). The class keeps `query`, `run`, `scalar`, `transaction`, `persist`, `insertRow`,
`insertRowRaw`, `enqueueSync`, `audit`, `init`, `close` and the booking commands.

**`enqueueSync` is a store primitive, not outbox vocabulary.** It is 18 lines that read the row back
from the database to build the payload, and fourteen write methods call it. Everything that looked
like a separable group routed through it, which is why the settings group looked impossible to move
until the right question was asked: passing a storage primitive through the interface is the seam,
not a shim. A module that reached for `createReservation` instead would be the split going wrong.

**Measure before choosing a group, and measure the right thing.** A coupling scan of `this.X` per
method cannot tell a one-line delegation from a method with behaviour, and it found neither the
signature differences nor the accessors. The five outbox wrappers looked like a group and were
delegations to `src/main/outbox.cjs`: delete them instead of moving them. What actually found the
read models was ranking all 62 members by size and by domain-call count in one pass.

**Never compute line ranges and delete them in reverse.** That broke three times, each time cutting
into a neighbouring method, because overlapping ranges cannot be removed that way. Partition the file
into members where every line belongs to exactly one and the ranges cannot overlap. The partition
removed exactly the 183 lines the measurement predicted, first try.

**A removed method behind optional chaining fails silently.** `database?.pendingSyncCount?.()`
returns `undefined`, the `?? 0` turns it into zero, and the app reports an empty queue while rows sit
in it. Every unit test passed; `e2e-sync.mjs` failed four checks and named them. Writing the rule down
in this file did not prevent the next occurrence. The suite did. That is the Law of Failure's own
ordering applied to itself.

## The Law of Failure (and where documentation sits in it)

When an agent repeats a mistake, **do not update the prompt — fix the environment.** Documentation
is the LAST resort, not the first, and it is last because a rule somebody has to remember is a rule
that fails on the day they are tired. In order:

1. **Fix the architecture** so the wrong thing cannot be expressed — force a boundary, move the
   decision into the one module that owns it. A view that never imports the shell cannot create a
   cycle; a renderer that cannot do arithmetic cannot disagree with the server about a price.
2. **Fix the types.** This project ships ES modules with no build step and **has no type checker**,
   by an earlier decision — so the rung is occupied by the shared domain modules and the fixtures
   both stacks are pinned to. Adding TypeScript to a finished product is its own decision.
3. **Add a lint rule.** There is no linter here either; the role is played by the guard tests, which
   is why they are strict and why a new one is the normal response to a new class of mistake:
   `tests/styles.test.cjs` (a colour literal outside the token blocks), `tests/module-graph.test.cjs`
   (a sibling's export used without importing it), `tests/i18n.test.cjs` (a label with no
   translation), `.githooks/pre-commit` (a commit on main).
4. **Add a CI test.** `scripts/e2e-*.mjs` for behaviour, `tests/*.test.cjs` for rules.
5. **Update documentation.** Here — and only after the four rungs above.

**The order is the whole content of the rule.** A repeated mistake answered with a paragraph is a
mistake that will repeat; the same mistake answered with a check is over.

## The mechanical layer: do not hand-write a probe

Two loops of this project's history consist of hand-written probe scripts in `/tmp` — thirteen of
them at once, each slightly different, none reviewed, none reusable — answering questions that get
asked every single session: what is on the page, what does this element compute to, is the text
readable, does the module graph link, what is queued for sync.

That is the failure `scripts/inspect.mjs` replaces. **The judgement is the agent's; the mechanics
belong in a rigid tool.**

```bash
node scripts/inspect.mjs status                 # attached, signed in, what page, what counts
node scripts/inspect.mjs page calendar          # go there and read what rendered
node scripts/inspect.mjs style '.field input' backgroundColor color
node scripts/inspect.mjs contrast dark          # the readability floor, measured live
node scripts/inspect.mjs imports                # every renderer module links
node scripts/inspect.mjs lists reservations
node scripts/inspect.mjs sync
node scripts/inspect.mjs shot /tmp/x.png
node scripts/inspect.mjs logs 40
```

Output is JSON, so reading it is parsing rather than scraping. Reaching for a new `/tmp/rk-*.mjs`
instead means the tool is missing a command — add the command.

The measurement itself lives in `scripts/lib/measure.mjs` and is used by BOTH this CLI and
`e2e-interface.mjs`. Two copies would eventually disagree about which surfaces count, which is the
drift the fixtures exist to prevent, one level up.

## Choosing a procedure instead of improvising one

`scripts/playbook.sh <kind> "<goal>" "<verification>"` routes by the nature of the work — `bugfix`,
`feature`, `refactor`, `perf`, `release` — from `playbooks/*.json`. The steps are data, and the
router **refuses to start without a verification condition**, exiting 3: "make it better" has no
exit, while "the failing test now passes" does. An agent given a goal will improve something; an
agent given a verification condition has something to be wrong about.

## Visual defects and the e2e suites

The detail lives in `docs/ui-findings.md` (layout faults found by reading screenshots, and the
readability measurements) and `docs/e2e-suites.md` (the suites, the harness replay that was the
long-standing flake, and the traps in writing one). Read them when touching the interface or a
suite; the rules that matter every session are here:

- **`[hidden] { display: none !important }` is load-bearing.** A UA `[hidden]` rule loses to any
  class, so `.empty-state { display: grid }` kept four elements on screen while the renderer
  believed they were hidden.
- **A custom property that does not exist invalidates the whole declaration.** `border: 1px solid
  var(--border)` silently removed the border. Grep for used-but-undefined tokens after touching
  the palette — the one-liner is in `docs/ui-findings.md`.
- **`animation-fill-mode: both` hides what it decorates** in a window that is not compositing.
  The remedy is one pass, not one handler per element: `settleEntranceMotion` in `js/app.js`
  finishes any animation whose `currentTime` has not moved since it was sampled, and a
  `MutationObserver` arms it again on every render, so a new animated element is covered without
  anybody remembering. The per-element rule that survives, and that `tests/styles.test.cjs`
  enforces, is that an entrance must END VISIBLE and must END AT ALL: an infinite animation, or a
  last keyframe that hides, is content the pass cannot give back.
  The measurement that decided the design is worth keeping. In a genuinely occluded window the
  stuck animation reports `running` with `currentTime` frozen at 0, NOT `pending`, so a rule that
  settled everything still running after N ms would cut long animations for a normal user, and one
  that settled only `pending` animations would miss the real case. Movement is the only thing that
  separates a motion from a freeze.
- **The harness must never replay a block.** It polls `window[token]`; a retry re-runs a write and
  reports the collision as a product bug. Do not reintroduce one.
- **Never reuse fixed date offsets in a fixture** — and derive the ASSERTION from the booking too,
  not from a hard-coded window.
- **The Electron window reports `visibilityState === "hidden"` when occluded**, so a measurement
  or screenshot must neutralise animation first.

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
