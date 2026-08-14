// Minimal admin surface, authenticated separately from customer auth via the
// ADMIN_API_KEY secret. Exists so the captain can see account/user counts and
// basic health, with an eye toward a future paid subscription (accounts.plan).
// Keep this separate from the customer API/auth.

import { badRequest, json, notFound, readJson } from "./http";
import { nowIso } from "./time";
import { Router } from "./router";
import type { Repository } from "./repository";
import { isKnownPlan, PLANS } from "./plans";

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

  // Plan catalog with current account counts per plan. Single source of truth
  // for limits is plans.ts (@see PLANS).
  router.get("/admin/plans", async () => {
    const counts = await repo.listPlansWithAccountCounts();
    const byPlan = Object.fromEntries(counts.map((row) => [row.plan, row.accounts]));
    return json({
      plans: PLANS.map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        maxPlaces: plan.maxPlaces,
        maxProperties: plan.maxProperties,
        accounts: byPlan[plan.id] ?? 0,
      })),
    });
  }, "admin");

  // Admin plan change for any account (support/testing; billing automation is
  // later). Mirrors the owner-facing PATCH /account/plan.
  router.patch("/admin/accounts/:id/plan", async (c) => {
    const accountId = c.params.id!;
    const account = await repo.getAccount(accountId);
    if (!account) throw notFound();
    const body = await readJson(c.request);
    const plan = String(body.plan ?? "").trim();
    if (!isKnownPlan(plan)) throw badRequest("validation_error", "Некорректный тариф плана");
    const updated = await repo.updateAccountPlan(accountId, plan);
    return json({
      account: {
        id: updated!.id,
        name: updated!.name,
        plan: updated!.plan,
        createdAt: updated!.created_at,
        updatedAt: updated!.updated_at,
      },
    });
  }, "admin");

  return router;
}
