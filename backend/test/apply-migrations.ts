// Setup file run once per test file (outside per-test storage isolation).
// Applies all un-applied D1 migrations, and registers a per-test database
// truncation so every test starts from a clean, migrated schema.
import { applyD1Migrations } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { resetDb } from "./db";

const env = workerEnv as unknown as { DB: D1Database; TEST_MIGRATIONS: unknown };
const migrations = env.TEST_MIGRATIONS as Parameters<typeof applyD1Migrations>[1];

await applyD1Migrations(env.DB, migrations);

beforeEach(async () => {
  await resetDb();
});
