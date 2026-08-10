// Minimal admin surface, authenticated separately from customer auth via the
// ADMIN_API_KEY secret. Exists so the captain can see account/user counts and
// basic health, with an eye toward a future paid subscription (accounts.plan).
// Keep this separate from the customer API/auth.

import { json, notFound } from "./http";
import { nowIso } from "./time";
import { Router } from "./router";
import type { Repository } from "./repository";

export function buildAdminRouter(repo: Repository): Router {
  const router = new Router(repo);

  router.get("/admin/health", async () => {
    return json({ ok: true, now: nowIso(), d1: "ok" });
  }, "admin");

  router.get("/admin/overview", async () => {
    const [accounts, users, invites, reservations, places, properties, plans] = await Promise.all([
      repo.countAll("accounts"),
      repo.countAll("users"),
      repo.countAll("invites"),
      repo.countAll("reservations"),
      repo.countAll("places"),
      repo.countAll("properties"),
      repo.plansBreakdown(),
    ]);
    return json({
      ok: true,
      now: nowIso(),
      accounts,
      users,
      invites,
      reservations,
      places,
      properties,
      plans,
    });
  }, "admin");

  router.get("/admin/accounts", async () => {
    const accounts = await repo.listAccounts();
    const items = await Promise.all(
      accounts.map(async (account) => ({
        id: account.id,
        name: account.name,
        plan: account.plan,
        createdAt: account.created_at,
        ...(await repo.accountStats(account.id)),
      })),
    );
    return json({ accounts: items });
  }, "admin");

  router.get("/admin/accounts/:id", async (c) => {
    const account = await repo.getAccount(c.params.id!);
    if (!account) throw notFound();
    return json({
      account: {
        id: account.id,
        name: account.name,
        plan: account.plan,
        createdAt: account.created_at,
        updatedAt: account.updated_at,
      },
      stats: await repo.accountStats(account.id),
    });
  }, "admin");

  return router;
}
