import { describe, expect, it } from "vitest";
import { api, json, createAccount, placePayload, propertyPayload } from "./helpers";

const SETUP_TOKEN = "test-setup-token";

describe("plan limits", () => {
  it("allows exactly one place on the free plan, then enforces the limit", async () => {
    const { token } = await createAccount("limits1@example.test", "Дом");

    const first = await api("POST", "/places", { token, body: placePayload({ name: "Первый" }) });
    expect(first.status).toBe(201);

    const second = await api("POST", "/places", { token, body: placePayload({ name: "Второй" }) });
    expect(second.status).toBe(403);
    const body = await json<{ error: { code: string; message: string } }>(second);
    expect(body.error.code).toBe("plan_limit");
    expect(body.error.message).toContain("1");
  });

  it("enforces the free property limit independently of places", async () => {
    const { token } = await createAccount("limits2@example.test", "Дом");
    const place = (await json<{ place: { id: string } }>(
      await api("POST", "/places", { token, body: placePayload() }),
    )).place;

    const first = await api("POST", "/properties", {
      token,
      body: propertyPayload({ placeId: place.id, name: "Объект один" }),
    });
    expect(first.status).toBe(201);

    const second = await api("POST", "/properties", {
      token,
      body: propertyPayload({ placeId: place.id, name: "Объект два" }),
    });
    expect(second.status).toBe(403);
    const body = await json<{ error: { code: string } }>(second);
    expect(body.error.code).toBe("plan_limit");
  });

  it("does not count archived records toward the limit", async () => {
    const { token } = await createAccount("limits3@example.test", "Дом");

    const place = (await json<{ place: { id: string } }>(
      await api("POST", "/places", { token, body: placePayload({ name: "Первый дом" }) }),
    )).place;

    // Limit is now reached; archiving the only place frees the slot.
    const archived = await api("POST", `/places/${place.id}/archive`, { token });
    expect(archived.status).toBe(200);
    expect((await json<{ place: { status: string } }>(archived)).place.status).toBe("archived");

    const replacement = await api("POST", "/places", { token, body: placePayload({ name: "Замена" }) });
    expect(replacement.status).toBe(201);
  });

  it("allows a business plan to exceed the free limits", async () => {
    const { token } = await createAccount("limits4@example.test", "Дом");

    const changed = await api("PATCH", "/account/plan", { token, body: { plan: "business" } });
    expect(changed.status).toBe(200);

    const first = await api("POST", "/places", { token, body: placePayload({ name: "Дом бизнес 1" }) });
    expect(first.status).toBe(201);
    const second = await api("POST", "/places", { token, body: placePayload({ name: "Дом бизнес 2" }) });
    expect(second.status).toBe(201);
  });

  it("creates multiple places and properties on the business plan", async () => {
    const { token } = await createAccount("biz1@example.test", "Дом");
    await api("PATCH", "/account/plan", { token, body: { plan: "business" } });

    const p1 = (await json<{ place: { id: string } }>(
      await api("POST", "/places", { token, body: placePayload({ name: "Бизнес дом А" }) }),
    )).place;
    const p2 = (await json<{ place: { id: string } }>(
      await api("POST", "/places", { token, body: placePayload({ name: "Бизнес дом Б" }) }),
    )).place;

    const prop1 = await api("POST", "/properties", { token, body: propertyPayload({ placeId: p1.id, name: "Объект 1" }) });
    expect(prop1.status).toBe(201);
    const prop2 = await api("POST", "/properties", { token, body: propertyPayload({ placeId: p2.id, name: "Объект 2" }) });
    expect(prop2.status).toBe(201);
  });
});

describe("manual plan change", () => {
  it("lets the owner change the plan and reflects it in /auth/me", async () => {
    const { token } = await createAccount("plan1@example.test", "Дом");

    const meBefore = await json<{ plan: string }>(await api("GET", "/auth/me", { token }));
    expect(meBefore.plan).toBe("free");

    const changed = await api("PATCH", "/account/plan", { token, body: { plan: "business" } });
    expect(changed.status).toBe(200);
    const changedBody = await json<{ plan: string }>(changed);
    expect(changedBody.plan).toBe("business");

    const meAfter = await json<{ plan: string }>(await api("GET", "/auth/me", { token }));
    expect(meAfter.plan).toBe("business");
  });

  it("rejects an invalid plan value", async () => {
    const { token } = await createAccount("plan2@example.test", "Дом");
    const response = await api("PATCH", "/account/plan", { token, body: { plan: "platinum" } });
    expect(response.status).toBe(400);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("validation_error");
  });

  it("forbids a non-owner from changing the plan", async () => {
    const { token } = await createAccount("plan3@example.test", "Дом");
    await api("POST", "/auth/invites", { token, body: { email: "staff-plan3@example.test", role: "staff" } });
    const sent = await api("POST", "/auth/send", { body: { email: "staff-plan3@example.test" } });
    const sentBody = await json<{ code: string }>(sent);
    const staff = await api("POST", "/auth/verify", {
      body: { email: "staff-plan3@example.test", code: sentBody.code },
    });
    const staffBody = await json<{ token: string; user: { role: string } }>(staff);
    expect(staffBody.user.role).toBe("staff");

    const response = await api("PATCH", "/account/plan", { token: staffBody.token, body: { plan: "business" } });
    expect(response.status).toBe(403);
  });
});
