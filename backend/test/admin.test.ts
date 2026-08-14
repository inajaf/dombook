import { describe, expect, it } from "vitest";
import { api, json, createAccount, placePayload } from "./helpers";

const ADMIN_KEY = "test-admin-key";
const SETUP_TOKEN = "test-setup-token";

describe("admin API", () => {
  it("rejects requests without the admin key", async () => {
    for (const path of ["/admin/health", "/admin/overview", "/admin/accounts"]) {
      const response = await api("GET", path);
      expect(response.status).toBe(401);
    }
  });

  it("rejects requests with a wrong admin key", async () => {
    const response = await api("GET", "/admin/health", { adminKey: "wrong-key" });
    expect(response.status).toBe(401);
  });

  it("exposes health", async () => {
    const response = await api("GET", "/admin/health", { adminKey: ADMIN_KEY });
    expect(response.status).toBe(200);
    const body = await json<{ ok: boolean; now: string; d1: string }>(response);
    expect(body.ok).toBe(true);
    expect(body.d1).toBe("ok");
    expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("overview counts all entities", async () => {
    const { token, accountId } = await createAccount("admin1@example.test", "Дом", SETUP_TOKEN);
    const place = await api("POST", "/places", { token, body: placePayload() });
    expect(place.status).toBe(201);

    const response = await api("GET", "/admin/overview", { adminKey: ADMIN_KEY });
    expect(response.status).toBe(200);
    const body = await json<{
      accounts: number;
      users: number;
      places: number;
      properties: number;
      reservations: number;
    }>(response);
    expect(body.accounts).toBeGreaterThanOrEqual(1);
    expect(body.users).toBeGreaterThanOrEqual(1);
    expect(body.places).toBeGreaterThanOrEqual(1);
    expect(body.properties).toBe(0);
    expect(body.reservations).toBe(0);
  });

  it("lists accounts with stats and looks up a single account", async () => {
    const { token, accountId } = await createAccount("admin2@example.test", "Сосновый бор", SETUP_TOKEN);
    await api("POST", "/places", { token, body: placePayload({ name: "Главный дом" }) });

    const list = await api("GET", "/admin/accounts", { adminKey: ADMIN_KEY });
    expect(list.status).toBe(200);
    const listBody = await json<{ accounts: { id: string; name: string; plan: string; places: number }[] }>(list);
    const mine = listBody.accounts.find((a) => a.id === accountId);
    expect(mine).toBeDefined();
    expect(mine!.name).toBe("Сосновый бор");
    expect(mine!.places).toBe(1);

    const one = await api("GET", `/admin/accounts/${accountId}`, { adminKey: ADMIN_KEY });
    expect(one.status).toBe(200);
    const oneBody = await json<{
      account: { id: string; name: string; plan: string };
      stats: { userCount: number; reservationCount: number; syncVersion: number };
    }>(one);
    expect(oneBody.account.id).toBe(accountId);
    expect(oneBody.stats.userCount).toBeGreaterThanOrEqual(1);
    expect(oneBody.stats.reservationCount).toBe(0);
    expect(oneBody.stats.syncVersion).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown account id", async () => {
    const response = await api("GET", "/admin/accounts/nope", { adminKey: ADMIN_KEY });
    expect(response.status).toBe(404);
  });

  it("lists plans with account counts and enforces auth", async () => {
    await createAccount("admin-plans@example.test", "Дом", SETUP_TOKEN);

    const noKey = await api("GET", "/admin/plans");
    expect(noKey.status).toBe(401);

    const response = await api("GET", "/admin/plans", { adminKey: ADMIN_KEY });
    expect(response.status).toBe(200);
    const body = await json<{ plans: { id: string; maxPlaces: number | null; accounts: number }[] }>(response);
    const free = body.plans.find((p) => p.id === "free");
    const business = body.plans.find((p) => p.id === "business");
    expect(free).toBeDefined();
    expect(free!.maxPlaces).toBe(1);
    expect(business).toBeDefined();
    expect(business!.maxPlaces).toBeNull();
    expect(body.plans.length).toBeGreaterThanOrEqual(2);
  });

  it("changes an account's plan via the admin endpoint", async () => {
    const { token, accountId } = await createAccount("admin-plan2@example.test", "Дом", SETUP_TOKEN);
    const free = await json<{ plan: string }>(await api("GET", "/auth/me", { token }));
    expect(free.plan).toBe("free");

    const response = await api("PATCH", `/admin/accounts/${accountId}/plan`, {
      adminKey: ADMIN_KEY,
      body: { plan: "business" },
    });
    expect(response.status).toBe(200);
    const body = await json<{ account: { id: string; plan: string } }>(response);
    expect(body.account.id).toBe(accountId);
    expect(body.account.plan).toBe("business");

    const me = await json<{ plan: string }>(await api("GET", "/auth/me", { token }));
    expect(me.plan).toBe("business");
  });

  it("rejects an invalid plan in the admin endpoint and a missing account", async () => {
    const { accountId } = await createAccount("admin-plan3@example.test", "Дом", SETUP_TOKEN);

    const invalid = await api("PATCH", `/admin/accounts/${accountId}/plan`, {
      adminKey: ADMIN_KEY,
      body: { plan: "nonsense" },
    });
    expect(invalid.status).toBe(400);

    const missing = await api("PATCH", "/admin/accounts/nope/plan", {
      adminKey: ADMIN_KEY,
      body: { plan: "business" },
    });
    expect(missing.status).toBe(404);
  });
});
