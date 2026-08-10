// Per-test database reset helper. Truncates every table so each test starts
// from a clean, already-migrated database (schema is applied once by the
// setup file). Table order is child-first so FK constraints would hold even if
// they were enabled.
import { env as workerEnv } from "cloudflare:workers";

const env = workerEnv as unknown as { DB: D1Database };

const TABLES = [
  "reservation_meals",
  "reservation_services",
  "reservation_nights",
  "reservations",
  "properties",
  "places",
  "app_settings",
  "audit_log",
  "invites",
  "sessions",
  "verification_codes",
  "users",
  "tenant_state",
  "accounts",
] as const;

export async function resetDb(): Promise<void> {
  for (const table of TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}
