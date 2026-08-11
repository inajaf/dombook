# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Schema & ids

Desktop domain tables (places, properties, reservations, reservation_nights, reservation_services, reservation_meals, app_settings, audit_log) use **UUID TEXT ids** plus sync columns `created_at`, `updated_at`, `deleted_at`, `version`, `last_writer`, matching the SaaS baseline (`backend/migrations/0001_baseline.sql`, minus `tenant_id` — desktop is single-tenant). `version` starts at 1 and every write bumps it. Legacy integer-id databases are migrated in-place by `migrateLegacyIntegerIds()` (`src/database.cjs`), registered as migration `sync_schema_v1`; the old `ensureColumn` mechanism is kept for backward compatibility. New rows need an explicit `crypto.randomUUID()` id; `last_insert_rowid()` is gone.

## Cloud auth (Phase 1 desktop login)

Desktop talks to the SaaS backend over plain Node `fetch` (no network lib) via `src/main/auth.cjs` (`createAuthApi`) with a `safeStorage`-encrypted JWT persisted by `src/main/auth-session.cjs` to `<userData>/auth-session.bin`. API base URL defaults to `http://127.0.0.1:8787` (override with `DOMBOOK_API_URL`). IPC channels are `auth:status|send|setup|verify|setPlan|logout` wired in `src/main.cjs` and exposed to the renderer as `window.domBook.auth` (see `src/preload.cjs`). Login is **required**: there is no offline escape hatch — the renderer gates all app data behind a restored session; a signed-out window shows only the login screen. After a successful OTP verify the renderer shows a plan picker (free/business); selecting business calls `auth:setPlan` → `PATCH /account/plan`, which ships with the phase-2 subscriptions backend (the running local API returns 404 — the desktop still wires the call and surfaces a friendly message, keeping free). In dev the backend sets `AUTH_EXPOSE_CODE=true` so `/auth/send` echoes the OTP in the response; the login UI surfaces that code, production relies on email delivery. Backend contract is authoritative in `docs/saas-spec.md` §4.1/§5.1.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
