# DomBook SaaS — Technical Specification

Status: **implemented (phase 1)** · Applies to: `backend/` (Cloudflare Workers + D1)
Last updated: 2026-08-11

This document is the canonical specification for the DomBook multi-tenant cloud
backend: architecture, data model, authentication, API surface, sync protocol,
admin panel, configuration, portability, testing, and phasing. It mirrors the
desktop application's domain model (`src/domain/booking/booking-policy.cjs`,
`src/database.cjs`) so cloud and desktop enforce identical business rules.

---

## 1. Overview

DomBook is a booking manager for guest houses ("дома отдыха"). The desktop app
stores everything locally in SQLite. Phase 1 adds a **cloud database and API**
that:

- hosts each business as an isolated **tenant** (`accounts`);
- authenticates humans with **passwordless email OTP** and issues JWT sessions;
- replicates domain rows to/from desktop clients via a **versioned sync
  protocol** with last-write-wins conflict resolution;
- exposes an **admin panel** (separate key) for platform health and accounts.

Two clients consume the API: the desktop app (sync/backup) and a future web
client. The backend is written as a plain HTTP service so it can run either on
Cloudflare Workers (current) or on a VPS with SQLite (portability path, §10).

---

## 2. Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │  Worker entrypoint (src/index.ts)            │
                       │  composition root, CORS, OPTIONS, error box  │
                       └───────────────┬──────────────────────────────┘
                     path starts with   │
                     /admin/            │ else
                       ┌───────────────▼──────────────┐
                       │ buildAdminRouter (src/admin.ts)│
                       └───────────────┬──────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  Router (src/router.ts, URLPattern)  │
                    │  requireAuth / requireAdmin guards   │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  AuthService (src/auth.ts)           │
                    │  setup · sendCode · verify · logout   │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  Repository (src/repository.ts)      │
                    │  all SQL; the only DB accessor        │
                    └──────────────────┬──────────────────┘
                                       │
                              ┌────────▼────────┐
                              │ D1 (Cloudflare) │  → SQLite on VPS (§10)
                              └─────────────────┘
```

Layering rules:

- **`src/index.ts`** — the only file with a Cloudflare-specific shape
  (`ExportedHandler`, `env.DB`). Everything below it is Cloudflare-agnostic.
- **`src/repository.ts`** — every SQL statement lives here. Other modules never
  touch the database directly. This is the seam for the VPS port.
- **`src/http.ts`** — error objects (`ApiError`), JSON responses, request body
  parsing, and the central error-to-response mapping.
- **`src/middleware.ts`** — `requireAuth` (JWT + active session + user load) and
  `requireAdmin` (static admin key, constant-time compare).
- **`src/router.ts`** — minimal router over the platform `URLPattern`; route
  handlers receive a typed context (`RouteContext`) and may declare a guard.

---

## 3. Multi-tenant data model

Schema lives in `backend/migrations/0001_baseline.sql` (SQLite-compatible, so
the VPS path needs no schema rewrite).

### 3.1 Tenancy core

| Table | Purpose |
|---|---|
| `accounts` | one row per business; `plan` ∈ `free \| pro \| business` (default `free`) |
| `users` | authenticated identities; `account_id`, unique `email`, `role` ∈ `owner \| admin \| staff` |
| `verification_codes` | OTP codes for passwordless login; single-use, time-limited |
| `sessions` | JWT `jti` rows supporting logout/revocation |
| `invites` | email invitations (`pending \| accepted \| revoked`) to join an account |
| `tenant_state` | per-tenant sync watermark: monotonic `version` (see §6) |
| `audit_log` | append-only `{entity_type, entity_id, action, payload_json}` trail |

`users` intentionally mirrors the table layout used by
`@cloudflare/workers-auth-provider`, so the in-repo provider (`src/auth.ts`) can
later be swapped for the official package without a migration.

### 3.2 Domain tables

Every desktop domain table is carried over with the same column names plus a
uniform tenancy/sync suffix:

- `tenant_id` — FK to `accounts(id)`; **every query filters on it**.
- `id` — UUID (`crypto.randomUUID()`), replaces desktop integer ids.
- `deleted_at` — soft delete; active-row unique indexes filter on `deleted_at IS NULL`.
- `updated_at`, `version`, `last_writer` — sync metadata (see §6).

| Table | Notes |
|---|---|
| `places` | guest-house entity; `has_food_service`, per-meal prices (`breakfast/lunch/dinner_price_minor`), `status ∈ active \| archived`; unique `(tenant_id, name)` while active |
| `properties` | bookable units (cottage/house); `place_id` (nullable), `capacity`, `base_price_minor`, `deposit_minor`, `currency`, `check_in_time`/`check_out_time`; unique `(tenant_id, name)` while active |
| `reservations` | booking; `status ∈ hold, confirmed, checked_in, checked_out, cancelled, no_show`; money columns in minor units (`accommodation_minor`, `services_minor`, `total_minor`, `prepaid_minor`, `deposit_minor`); `deposit_status ∈ none, due, received, returned, partially_withheld, withheld` |
| `reservation_nights` | one row per occupied night; unique `(property_id, night_date)` while active → prevents double-booking |
| `reservation_services` | meals as services with `service_type ∈ breakfast, lunch, dinner`, `unit_price_minor`, `quantity`; unique `(reservation_id, service_type)` while active |
| `reservation_meals` | per-date meal breakdown (`meal_date`, `meal_type`, `amount_minor`); unique `(reservation_id, meal_date, meal_type)` while active |
| `app_settings` | key/value tenant settings; unique `(tenant_id, setting_key)` |

Child tables (`reservation_nights/services/meals`) `ON DELETE CASCADE` from
`reservations`; the repository still refuses to hard-delete active reservations
(§5.4).

### 3.3 Booking policy (shared with desktop)

`backend/src/time.ts` is a standalone copy of
`src/domain/booking/booking-policy.cjs` so cloud and desktop agree exactly:

- `maximumAdvanceDays = 21` — check-in cannot be more than 21 days ahead.
- `maximumStayMonths = 3` — check-out cannot exceed check-in + 3 calendar months.
- `timeZone = "Asia/Baku"` — "today" is computed in this timezone everywhere.
- Past check-in is rejected. Unchanged dates on update skip re-validation.

---

## 4. Authentication & authorization

### 4.1 Passwordless email OTP flow

1. **`POST /auth/setup`** — creates the account + owner user (idempotent per
   email). Gating: while the `users` table is empty the endpoint is **public**;
   once any user exists it returns `403 setup_denied` unless a valid
   `SETUP_TOKEN` (server secret) is supplied in the body. This prevents
   squatting of the first account in production.
2. **`POST /auth/send`** — generates a 6-digit OTP (`otpCode()`), stores it
   (SHA-256 hashed) in `verification_codes`, and "sends" it. With
   `AUTH_EXPOSE_CODE=true` (dev) the code is returned in the response;
   otherwise a real email/transport provider must be attached (§12).
3. **`POST /auth/verify`** — validates the code, creates a `sessions` row, and
   issues a signed JWT (`HS256`). If the email matches a pending invite, the
   invite is accepted and the user is joined to the inviting account.

### 4.2 Sessions

- JWT claims: `sub` (user id), `jti` (session id), `iat`, `exp`.
- `AUTH_SESSION_TTL_SECONDS` (default 30 days) controls expiry; the JWT is
  rejected server-side if the `sessions` row is revoked or expired.
- `POST /auth/logout` revokes the session row (kills the JWT).
- `GET /auth/me` returns the current user, account id/name, and plan.

### 4.3 Roles

- `owner` — created by setup. Full access.
- `admin` / `staff` — added via invites.
- `ensureRole` guards invite listing/creation/revocation to `owner`/`admin`.
  Invites can grant `admin` or `staff` only (never `owner`).

### 4.4 Admin access (platform)

`/admin/*` routes authenticate with a static bearer key `ADMIN_API_KEY`
(compared in constant time), completely separate from customer auth. See §7.

---

## 5. API surface

Base URL: `https://api.dombook.../` (CORS enabled, `*`). Content-type is
`application/json`. Errors use `ApiError`:

```json
{ "error": { "code": "validation_error", "message": "…" } }
```

Common HTTP statuses: `400` validation, `401` auth, `403` role/tenant, `404`
not found, `409`-style handled as `400` with codes like `reservation_conflict`.

### 5.1 Auth

| Method | Path | Guard | Description |
|---|---|---|---|
| POST | `/auth/setup` | public / `SETUP_TOKEN` | create account + owner; `201 { accountId, user }` |
| POST | `/auth/send` | public | send OTP; `{ loginable, code? }` |
| POST | `/auth/verify` | public | exchange OTP for JWT; `{ token, user, accountId, accountName, plan, inviteAccepted }` |
| GET | `/auth/me` | user | `{ user, accountId, accountName, plan }` |
| POST | `/auth/logout` | user | revoke session; `{ ok }` |
| GET | `/auth/invites` | user + role | list invites |
| POST | `/auth/invites` | user + role | create invite; returns `{ invite, inviteToken }` (raw token for the share link) |
| POST | `/auth/invites/:id/revoke` | user + role | revoke; `{ ok, invite }` |

### 5.2 Places

| Method | Path | Description |
|---|---|---|
| GET | `/places` | list (active) places |
| POST | `/places` | create; `201 { place }` |
| GET | `/places/:id` | single place |
| PUT | `/places/:id` | update |
| POST | `/places/:id/archive` | soft-set `status = archived` |
| POST | `/places/:id/restore` | `status = active` |
| DELETE | `/places/:id` | **hard** delete (permanent); unique-name index is active-row scoped |

Validation: name required and unique per tenant (case-insensitive); money
fields non-negative; `has_food_service` 0/1. Bodies are typed with
`PlaceInput`/`PropertyInput` and coerce camelCase payloads into snake_case rows.

### 5.3 Properties

| Method | Path | Description |
|---|---|---|
| GET | `/properties` | list |
| POST | `/properties` | create; rejects when linked `place_id` is missing or inactive |
| GET | `/properties/:id` | single |
| PUT | `/properties/:id` | update |
| POST | `/properties/:id/archive` / `/restore` | status toggles |
| DELETE | `/properties/:id` | hard delete |

Validation: `capacity > 0`, non-negative money, `currency`, check-in/out time
strings, unique name per tenant.

### 5.4 Reservations

| Method | Path | Description |
|---|---|---|
| GET | `/reservations` | list |
| POST | `/reservations` | create; `201 { reservation }` |
| GET | `/reservations/:id` | single |
| PUT | `/reservations/:id` | update |
| POST | `/reservations/:id/cancel` | set `status = cancelled` |
| DELETE | `/reservations/:id` | delete; **400 unless already cancelled** |

Server-side checks (mirror of desktop `validateReservation`):

- Booking window via `assertBookingDates` (§3.3).
- `reservation_nights` regenerated from `[check_in_date, check_out_date)`; an
  existing night for the same property/date conflicts → 400.
- Meals (`mealItems` with `date`, `type`, `amountMinor`) must fall inside the
  booked nights; meal pricing requires the linked place `has_food_service`.
- Money consistency: `total = accommodation + services`; `prepaid ≤ total`;
  `services_minor` = Σ meal amounts; `deposit_status` transitions validated.
- Every mutation writes an `audit_log` row and bumps the tenant sync version.

### 5.5 Settings

| Method | Path | Description |
|---|---|---|
| GET | `/settings` | `{ settings: [...] }` |
| PUT | `/settings/:key` | upsert `{ setting }`; key ≤ 64 chars, value ≤ 2000 |

Used today for theme (`theme` key). Generic key/value by design.

---

## 6. Sync protocol

The cloud database is the **canonical** store; desktop clients replicate.

### 6.1 Watermark

- `tenant_state.version` is a server-monotonic counter incremented by
  `bumpTenantVersion()` on **every** mutating operation and push. It is immune
  to client clock skew.
- Each synced row stores the `version` at which it was last written.

### 6.2 Pull

```
GET /sync/pull?since=<version>
→ { state: { version, updatedAt },
    changes: { places: Row[], properties: Row[], reservations: Row[],
               reservation_nights: Row[], reservation_services: Row[],
               reservation_meals: Row[], app_settings: Row[] } }
```

Returns every row in every sync table with `version > since`, ordered by
`version`. A client stores the returned `state.version` as its cursor.
`since = -1` returns everything (used by backup export).

### 6.3 Push

```
POST /sync/push { clientId: string, changes: { <table>: Row[] } }
→ { state: { version, updatedAt }, applied: number }
```

- Unknown table names → 400. Non-array payloads → 400.
- `clientId` becomes `last_writer` (max 64 chars, defaults to `unknown`).
- Each row is upserted by `(tenant_id, id)` with **last-write-wins**:
  `rowCompare` compares `updated_at`, then `last_writer`, then a canonical
  (sorted-key) JSON of the row. Older incoming rows are skipped (counted in
  `applied` only when the server actually applied them).
- **Partial rows**: only the columns the client sends are written. On insert,
  omitted NOT NULL columns fall back to their schema defaults (e.g. missing
  `breakfast_price_minor` → `0`); on update, omitted columns keep their stored
  values. This keeps the protocol tolerant of older/newer client versions.
- Every applied row bumps the tenant version, so a subsequent pull converges.

### 6.4 Conflict semantics

Conflicts are resolved deterministically and identically on every replica:

1. newest `updated_at` wins;
2. tie → lexicographically greater `last_writer` wins;
3. tie → canonical JSON comparison (sorting keys) decides; identical JSON → no-op.

The desktop app already stores `updated_at` and a writer id on each row, so the
server protocol maps directly onto existing client data.

---

## 7. Admin panel

Separate surface (`src/admin.ts`), authenticated by `ADMIN_API_KEY` only.
Intentionally minimal for phase 1; grows with subscription billing later.

| Method | Path | Description |
|---|---|---|
| GET | `/admin/health` | `{ ok, now, d1: "ok" }` — liveness + D1 reachability |
| GET | `/admin/overview` | counts of accounts/users/invites/reservations/places/properties + `plansBreakdown` |
| GET | `/admin/accounts` | accounts with per-account stats (`userCount`, `inviteCount`, `reservationCount`, `syncVersion`, `places`, `properties`) |
| GET | `/admin/accounts/:id` | single account + stats; 404 if unknown |

Admin routes bypass tenant scoping entirely and never leak customer tokens.

---

## 8. Configuration & secrets

`backend/wrangler.jsonc`:

| Key | Source | Default | Purpose |
|---|---|---|---|
| `APP_NAME` | `vars` | `ДомБук` | branding in OTP/emails |
| `AUTH_OTP_TTL_SECONDS` | `vars` | `600` | OTP lifetime |
| `AUTH_SESSION_TTL_SECONDS` | `vars` | `2592000` (30 d) | session/JWT lifetime |
| `AUTH_EXPOSE_CODE` | `vars` | `true` (dev) | return OTP in `/auth/send` (dev only; `false` in prod) |
| `JWT_SECRET` | secret | — | HMAC key for session JWTs |
| `ADMIN_API_KEY` | secret | — | admin bearer key |
| `SETUP_TOKEN` | secret | — | gates `/auth/setup` after first account |

Local dev secrets live in `backend/.dev.vars` (gitignored); production values
are Worker secrets. The vitest pool does **not** load `.dev.vars` — tests pin
their own values in `vitest.config.ts` bindings.

---

## 9. Backup & export

`GET /backups/export` returns a full tenant snapshot:

```json
{
  "exportedAt": "…ISO…",
  "schemaVersion": "0001",
  "accountId": "…",
  "state": { "version": … },
  "data": { "places": […], "properties": […], … }
}
```

It is a `since = -1` pull over all sync tables — version-complete, so a client
can restore to this exact point. On the desktop, this is the upload side of the
existing local backup (`database.createBackup()` writes a checksummed SQLite
file); the cloud export is the server-side canonical equivalent.

---

## 10. VPS migration path

The backend is deliberately re-hostable on a plain VPS (e.g. Node + SQLite)
without a schema rewrite or domain-logic changes:

- **Schema**: `0001_baseline.sql` is pure SQLite (no D1-only features). It can
  be executed by `better-sqlite3`/`node:sqlite` unchanged.
- **DB seam**: `Repository` is the only SQL consumer and is constructed from a
  `D1Database`. `Env` declares `DB` plus config vars. A VPS host swaps the D1
  binding for a SQLite-backed adapter implementing the same
  `prepare().bind().first()/all()/run()` surface.
- **Runtime**: `src/index.ts` is a plain HTTP entry (request → response). The
  same `fetch` shape can be served by Node's `http` module, Express, or
  Hono's Node adapter.
- **No Cloudflare-specifics below the seam**: router uses the platform
  `URLPattern`, which exists in Node ≥ 16 and browsers; Web Crypto
  (`crypto.subtle`, `randomUUID`) is available in Node ≥ 19 and Workers alike.

Migration order (if ever needed): (1) run migrations on SQLite, (2) point a
SQLite-backed `Repository` at it, (3) serve `src/index.ts` behind a TLS
reverse proxy, (4) keep `ADMIN_API_KEY`/`JWT_SECRET` as env vars.

---

## 11. Testing

Backend suite (`backend/test/`, vitest + `@cloudflare/vitest-pool-workers`):

- **Infra**: `vitest.config.ts` builds the pool with the real migrations applied
  via `readD1Migrations`, plus pinned test bindings
  (`JWT_SECRET`, `ADMIN_API_KEY`, `AUTH_EXPOSE_CODE=true`, `SETUP_TOKEN`).
  `test/apply-migrations.ts` applies the schema once and truncates all tables
  before each test (`resetDb`). `test/helpers.ts` drives the real worker entry
  `worker.fetch(request, env)` and provides `createAccount()` + payload
  builders.
- **`auth.test.ts`** — setup gating, OTP send/verify, session lifecycle,
  invites, logout.
- **`tenant-scoping.test.ts`** — cross-tenant isolation: account A can never
  read/write account B's rows; setup needs `SETUP_TOKEN` for the 2nd account.
- **`crud.test.ts`** — places/properties/reservations CRUD, archive/restore,
  soft vs hard delete, validation errors, booking-policy and meal checks.
- **`sync.test.ts`** — pull cursor, incremental since, push apply + tenant
  scoping, last-write-wins (older push loses), unknown-table rejection, backup
  export, full reservation-graph push/pull.
- **`admin.test.ts`** — 401 without/wrong key, health, overview counts,
  accounts list + single lookup, 404.
- **`helpers.test.ts`** — unit: JWT sign/verify round-trip, wrong secret,
  tampered, expired; `constantTimeEqual`; base64url; UUID/OTP/token shape;
  `addDaysIso`, `addCalendarMonths` (clamping), `todayInTimeZone`,
  `bookingLimits`, `assertBookingDates` accept/reject cases.

Current state: **60 tests / 6 files pass**, `tsc --noEmit` clean. Desktop suite
(`npm test` = 33 node tests) and `npm run test:smoke` pass; the smoke script
uses relative dates so it never breaks as "today" advances.

---

## 12. Phasing

**Phase 1 — implemented here**

- Multi-tenant accounts + users + invites + sessions (OTP auth, in-repo
  provider).
- Full domain CRUD with desktop-parity validation.
- Versioned sync (pull/push, LWW) + backup export.
- Admin panel (health/overview/accounts) behind `ADMIN_API_KEY`.
- Test suite + typecheck green; spec (this file).

**Phase 2 — next**

- Real OTP delivery (email provider; use the `code` from `/auth/send` when
  `AUTH_EXPOSE_CODE=false`).
- Plan enforcement: rate limits, per-plan feature flags and quotas keyed on
  `accounts.plan`.
- Public invite accept link (the `inviteToken` returned by `POST /auth/invites`
  is already generated for this).
- Subscription/billing admin endpoints (`/admin/plans`, invoicing).

**Phase 3 — later**

- Web client (same API, CORS already open).
- Push notifications / webhooks on reservation changes.
- Analytics over `audit_log` and reservation aggregates.
- VPS hosting per §10 if platform costs or data-residency requirements demand.
