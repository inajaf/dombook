import { env as workerEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BillingService } from "../src/billing";
import { Repository } from "../src/repository";
import type { Env } from "../src/env";
import { api, createAccount, json } from "./helpers";

const WEBHOOK_SECRET = "pdl_ntfset_test_secret";
const baseEnv = workerEnv as unknown as Env;

function service() {
  const env: Env = {
    ...baseEnv,
    DB: baseEnv.DB,
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  return { billing: new BillingService(env, new Repository(baseEnv.DB)), repo: new Repository(baseEnv.DB) };
}

async function signedWebhook(event: Record<string, unknown>, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}:${body}`),
  );
  const h1 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://api.dombook.test/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "paddle-signature": `ts=${timestamp};h1=${h1}` },
    body,
  });
}

describe("Paddle Billing", () => {
  it("provisions a paid plan once and downgrades on cancellation", async () => {
    const { token, accountId } = await createAccount("paddle-lifecycle@example.test", "Paddle дом");
    const { billing, repo } = service();
    await repo.createBillingCheckout(accountId, "txn_checkout_1", "business", "pri_business_1");

    const completedEvent = {
      event_id: "evt_completed_1",
      event_type: "transaction.completed",
      occurred_at: "2026-08-14T10:00:00.000Z",
      data: {
        id: "txn_checkout_1",
        subscription_id: "sub_business_1",
        customer_id: "ctm_1",
      },
    };
    const completed = await billing.handleWebhook(await signedWebhook(completedEvent));
    expect(completed.status).toBe(200);
    expect(await json(completed)).toMatchObject({ ok: true, applied: true });
    expect((await json<{ plan: string }>(await api("GET", "/auth/me", { token }))).plan).toBe("business");

    const duplicate = await billing.handleWebhook(await signedWebhook(completedEvent));
    expect(await json(duplicate)).toMatchObject({ ok: true, duplicate: true });

    const canceled = await billing.handleWebhook(await signedWebhook({
      event_id: "evt_canceled_1",
      event_type: "subscription.canceled",
      occurred_at: "2026-08-15T10:00:00.000Z",
      data: {
        id: "sub_business_1",
        status: "canceled",
        customer_id: "ctm_1",
        items: [{ price: { id: "pri_business_1" } }],
      },
    }));
    expect(canceled.status).toBe(200);
    expect((await json<{ plan: string }>(await api("GET", "/auth/me", { token }))).plan).toBe("free");
    expect((await billing.status(accountId)).subscription).toMatchObject({
      id: "sub_business_1",
      plan: "business",
      status: "canceled",
    });
  });

  it("does not let an older webhook overwrite newer subscription state", async () => {
    const { token, accountId } = await createAccount("paddle-order@example.test", "Paddle порядок");
    const { billing, repo } = service();
    await repo.createBillingCheckout(accountId, "txn_order_1", "business", "pri_business_1");
    await billing.handleWebhook(await signedWebhook({
      event_id: "evt_order_completed",
      event_type: "transaction.completed",
      occurred_at: "2026-08-14T10:00:00.000Z",
      data: { id: "txn_order_1", subscription_id: "sub_order_1", customer_id: "ctm_order" },
    }));
    await billing.handleWebhook(await signedWebhook({
      event_id: "evt_order_canceled",
      event_type: "subscription.canceled",
      occurred_at: "2026-08-16T10:00:00.000Z",
      data: { id: "sub_order_1", status: "canceled", customer_id: "ctm_order" },
    }));
    await billing.handleWebhook(await signedWebhook({
      event_id: "evt_order_stale",
      event_type: "subscription.updated",
      occurred_at: "2026-08-15T10:00:00.000Z",
      data: { id: "sub_order_1", status: "active", customer_id: "ctm_order" },
    }));

    expect((await json<{ plan: string }>(await api("GET", "/auth/me", { token }))).plan).toBe("free");
    expect((await billing.status(accountId)).subscription?.status).toBe("canceled");
  });

  it("rejects invalid and stale webhook signatures", async () => {
    const { billing } = service();
    const event = {
      event_id: "evt_bad_signature",
      event_type: "transaction.completed",
      occurred_at: "2026-08-14T10:00:00.000Z",
      data: {},
    };
    const invalid = new Request("https://api.dombook.test/billing/webhook", {
      method: "POST",
      headers: { "paddle-signature": "ts=1;h1=deadbeef" },
      body: JSON.stringify(event),
    });
    await expect(billing.handleWebhook(invalid)).rejects.toMatchObject({
      status: 401,
      code: "invalid_webhook_signature",
    });

    await expect(billing.handleWebhook(await signedWebhook(event, 1))).rejects.toMatchObject({
      status: 401,
      code: "invalid_webhook_signature",
    });
  });
});

