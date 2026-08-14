# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Schema & ids

Desktop domain tables (places, properties, reservations, reservation_nights, reservation_services, reservation_meals, app_settings, audit_log) use **UUID TEXT ids** plus sync columns `created_at`, `updated_at`, `deleted_at`, `version`, `last_writer`, matching the SaaS baseline (`backend/migrations/0001_baseline.sql`, minus `tenant_id` — desktop is single-tenant). `version` starts at 1 and every write bumps it. Legacy integer-id databases are migrated in-place by `migrateLegacyIntegerIds()` (`src/database.cjs`), registered as migration `sync_schema_v1`; the old `ensureColumn` mechanism is kept for backward compatibility. New rows need an explicit `crypto.randomUUID()` id; `last_insert_rowid()` is gone.

## Backend: plan limits & plan changes

- Single source of truth for subscription plans and per-plan quotas is `backend/src/plans.ts` (`PLANS`, `planDefinition`, `assertCanCreatePlace/Property`). Change limits there, not inline in routes.
- Limits apply to creating active places/properties only. Archived and soft-deleted rows do NOT count toward a plan's limit, so archiving frees a free-plan slot (verified by `backend/test/plans.test.ts`).
- Changing a plan: owner-facing `PATCH /account/plan` (role owner) and admin `PATCH /admin/accounts/:id/plan`; both call `Repository.updateAccountPlan`. `GET /admin/plans` lists the catalog with per-plan account counts.
- `accounts.plan` accepts `free | pro | business` (DB CHECK). `free` is capped (1 place + 1 property); `business` and the not-yet-priced `pro` are unlimited.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
