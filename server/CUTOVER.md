# Cutover: Cloudflare D1 → PostgreSQL

The product ran on Cloudflare Workers + D1. The Go server replaces it. This is the procedure
for moving a live account across, and the reasoning behind each step.

Nothing here is destructive to the source. The D1 database is opened **read-only**, so the
migration can be rehearsed, re-run, and abandoned without touching production.

## 1. Rehearse against a copy

```sh
# Copy the D1 file first; -source is opened read-only, but a copy means an accident
# cannot reach the original.
cp backend/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite /tmp/d1.sqlite

RENTKEEPER_DSN=postgres://owner@127.0.0.1:5432/dombook_cutover go run ./cmd/migrate up
RENTKEEPER_DSN=postgres://owner@127.0.0.1:5432/dombook_cutover go run ./cmd/migrate-d1 \
  -source /tmp/d1.sqlite -dry-run
```

A dry run reads and converts every row without writing. It is the check that catches a column
or type problem before the real run rather than halfway through it.

## 2. Import

```sh
RENTKEEPER_DSN=postgres://owner@127.0.0.1:5432/dombook_cutover go run ./cmd/migrate-d1 \
  -source /tmp/d1.sqlite
```

The whole import is **one transaction**. A migration that half-applies is worse than one that
fails: the operator cannot tell which rows arrived, and re-running duplicates them. Either
every table lands or none does, so a failure can be fixed and retried.

It **refuses a non-empty target**. Importing on top of existing rows would duplicate them with
no way to tell which came from where. `-allow-non-empty` exists for a deliberate merge.

## 3. Run the API as the application role

```sh
RENTKEEPER_DSN=postgres://rentkeeper_app:…@127.0.0.1:5432/dombook_cutover \
DOMBOOK_SKIP_MIGRATE=1 \
DOMBOOK_ADMIN_DSN=postgres://rentkeeper_admin:…@127.0.0.1:5432/dombook_cutover \
ADMIN_API_KEY=… JWT_SECRET=… \
go run ./cmd/api
```

`DOMBOOK_SKIP_MIGRATE=1` is **required in production**. The API connects as `rentkeeper_app`,
which is deliberately denied the ability to create objects, so the startup migration pass
fails with `permission denied for schema public`. The tempting fix is to run the API as a
privileged role — which would hand the request path the ability to bypass RLS. Migrations are
applied out of band by `cmd/migrate` as the owner instead.

## What is and is not migrated

| Migrated | Notes |
| --- | --- |
| `accounts`, `users` | Ids preserved, so a desktop client's stored references stay valid |
| `places` | |
| `properties` → `units` | D1 calls it a property; the server calls it a unit |
| `reservations` | `property_id` → `unit_id` |
| `reservation_nights` | `property_id` → `unit_id` |
| `reservation_services`, `reservation_meals` | |
| `app_settings` | Interface language and other per-account settings |
| `tenant_state` | **The version is carried over**, so clients resume from their cursor |
| `audit_log` | `version`/`deleted_at`/`updated_at` dropped: the destination has no such columns |

| Not migrated | Why |
| --- | --- |
| `sessions` | Credentials for the old deployment. Users sign in again with a one-time code |
| `verification_codes` | One-time codes bound to the old deployment |
| `invites` | Pending invitations can be re-sent |
| `billing_*`, `paddle_webhook_events` | Subscription rows for the model being replaced; the product now sells a one-time licence recorded in `account_entitlements` |
| `d1_migrations`, `_cf_METADATA` | Tool bookkeeping |

Identity is preserved verbatim, including row versions. Regenerating ids would make every
desktop client re-create its data as new rows — the duplicate-everything failure.

## 4. Point the desktop at the new server

`DOMBOOK_API_URL` selects the backend. Change the default in `src/main.cjs`, or set the
variable per installation, once the server is verified.

## Verifying the cutover

`scripts/verify-cutover.mjs` runs the checks that matter against a running server: that the
migrated user can sign in, that ids and versions survived, that a booking still joins to its
unit, that a client at its old cursor sees no spurious changes, and that credential rows were
left behind.

## Local state that was NOT in git

The legacy `backend/` directory was removed once the importer and these checks were in place.
Two things inside it were **gitignored**, so deleting them would have destroyed them:

- `backend/.wrangler/` — the local D1 database used by `wrangler dev`, holding a real account
  (`Дом отдыха` / `najaf.eldar@gmail.com`).
- `backend/.dev.vars` — local development secrets.

Both were copied to `~/Documents/dombook-legacy-backup-<date>/` before removal, with a README
explaining how to import the D1 file. If you need them, look there. If that directory is gone,
the local D1 state is gone: it was never in version control.

The committed source is recoverable from git regardless — `backend/` was removed in a commit
whose parent still contains it.
