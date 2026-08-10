import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Migrations are read on the Node side and injected into the test worker as a
// test-only binding, then applied by `test/apply-migrations.ts` setup.
const migrationsPath = path.join(import.meta.dirname, "migrations");

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsPath);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityDate: "2025-09-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Secrets are normally read from `.dev.vars` / Worker secrets; the
            // vitest pool does not load `.dev.vars`, so pin test-only values here.
            JWT_SECRET: "test-jwt-secret",
            ADMIN_API_KEY: "test-admin-key",
            AUTH_EXPOSE_CODE: "true",
            SETUP_TOKEN: "test-setup-token",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
