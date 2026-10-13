import { ApiError, badRequest, json } from "./http";
import { nowIso } from "./time";
import type { Env } from "./env";
import type { AccountPlan } from "./types";
import type { Repository } from "./repository";

const encoder = new TextEncoder();
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

type PaidPlan = Exclude<AccountPlan, "free">;

interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface BillingStatus {
  configured: boolean;
  environment: "sandbox" | "live";
  subscription: {
    id: string;
    plan: PaidPlan;
    status: string;
    currentPeriodEnd: string | null;
    scheduledChange: unknown;
  } | null;
}

export class BillingService {
  constructor(private env: Env, private repo: Repository) {}

  configured(): boolean {
    return Boolean(this.env.PADDLE_API_KEY && this.env.PADDLE_WEBHOOK_SECRET);
  }

  environment(): "sandbox" | "live" {
    return this.env.PADDLE_ENVIRONMENT === "live" ? "live" : "sandbox";
  }

  async status(accountId: string): Promise<BillingStatus> {
    const subscription = await this.repo.getBillingSubscription(accountId);
    return {
      configured: this.configured(),
      environment: this.environment(),
      subscription: subscription ? {
        id: subscription.paddle_subscription_id,
        plan: subscription.plan as PaidPlan,
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        scheduledChange: parseJson(subscription.scheduled_change_json),
      } : null,
    };
  }

  async createCheckout(accountId: string, plan: string): Promise<Response> {
    if (plan !== "pro" && plan !== "business") {
      throw badRequest("validation_error", "Для оплаты выберите платный тариф");
    }
    if (!this.env.PADDLE_API_KEY) throw billingUnavailable();
    const priceId = this.priceId(plan);
    if (!priceId) throw billingUnavailable(`Цена тарифа ${plan} ещё не настроена`);

    const existing = await this.repo.getBillingSubscription(accountId);
    if (existing && PAID_STATUSES.has(existing.status)) {
      throw badRequest("subscription_exists", "Активная подписка уже существует; измените её через управление подпиской");
    }

    const response = await fetch(`${this.apiBase()}/transactions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.PADDLE_API_KEY}`,
        "content-type": "application/json",
        "paddle-version": "1",
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: "automatic",
        custom_data: { dombook_account_id: accountId },
      }),
    });
    const payload = await response.json() as {
      data?: { id?: string; checkout?: { url?: string | null } };
      error?: { detail?: string };
    };
    if (!response.ok || !payload.data?.id) {
      throw new ApiError(502, "billing_provider_error", payload.error?.detail || "Paddle не создал checkout");
    }
    await this.repo.createBillingCheckout(accountId, payload.data.id, plan, priceId);
    const checkoutUrl = this.env.PADDLE_CHECKOUT_URL
      ? `${this.env.PADDLE_CHECKOUT_URL}${this.env.PADDLE_CHECKOUT_URL.includes("?") ? "&" : "?"}_ptxn=${encodeURIComponent(payload.data.id)}`
      : payload.data.checkout?.url ?? null;
    return json({
      transactionId: payload.data.id,
      checkoutUrl,
      clientToken: this.env.PADDLE_CLIENT_TOKEN ?? null,
      environment: this.environment(),
    }, 201);
  }

  checkoutPage(request: Request): Response {
    if (!this.env.PADDLE_CLIENT_TOKEN) throw billingUnavailable("Paddle.js token не настроен");
    const transactionId = new URL(request.url).searchParams.get("_ptxn") ?? "";
    if (!/^txn_[a-z0-9]+$/.test(transactionId)) {
      throw badRequest("validation_error", "Некорректный Paddle transaction ID");
    }
    const token = JSON.stringify(this.env.PADDLE_CLIENT_TOKEN);
    const transaction = JSON.stringify(transactionId);
    const sandbox = this.environment() === "sandbox" ? 'Paddle.Environment.set("sandbox");' : "";
    return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DomBook Business checkout</title><script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<style>body{margin:0;background:#f4f7f5;color:#16352c;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:520px;padding:32px;border-radius:20px;background:#fff;box-shadow:0 18px 60px #153c2e20;text-align:center}h1{margin-top:0}.muted{color:#65766f}</style></head>
<body><main class="card" id="status"><h1>DomBook Business</h1><p>Secure checkout is opening…</p><p class="muted">Payments are processed by Paddle.</p></main>
<script>${sandbox}
Paddle.Initialize({token:${token},eventCallback:function(event){if(event.name==="checkout.completed"){document.getElementById("status").innerHTML="<h1>Payment complete</h1><p>Your Business plan is being activated.</p>";}}});
Paddle.Checkout.open({transactionId:${transaction}});
</script></body></html>`, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.paddle.com https://*.paddle.com; frame-src https://*.paddle.com; connect-src https://*.paddle.com; style-src 'unsafe-inline'; img-src data: https://*.paddle.com",
      },
    });
  }

  async handleWebhook(request: Request): Promise<Response> {
    if (!this.env.PADDLE_WEBHOOK_SECRET) throw billingUnavailable("Webhook Paddle не настроен");
    const rawBody = await request.text();
    const signature = request.headers.get("paddle-signature") ?? "";
    if (!(await verifyPaddleSignature(rawBody, signature, this.env.PADDLE_WEBHOOK_SECRET))) {
      throw new ApiError(401, "invalid_webhook_signature", "Некорректная подпись Paddle webhook");
    }

    let event: PaddleEvent;
    try {
      event = JSON.parse(rawBody) as PaddleEvent;
    } catch {
      throw badRequest("invalid_json", "Некорректный Paddle webhook");
    }
    if (!event.event_id || !event.event_type || !event.occurred_at || !event.data) {
      throw badRequest("validation_error", "Неполный Paddle webhook");
    }
    if (await this.repo.hasPaddleEvent(event.event_id)) return json({ ok: true, duplicate: true });

    const resolved = await this.resolveSubscription(event);
    if (!resolved) {
      await this.repo.recordPaddleEvent(event.event_id, event.event_type, event.occurred_at, rawBody);
      return json({ ok: true, applied: false });
    }
    await this.repo.applyPaddleSubscriptionEvent({
      eventId: event.event_id,
      eventType: event.event_type,
      occurredAt: event.occurred_at,
      rawBody,
      ...resolved,
    });
    return json({ ok: true, applied: true });
  }

  private async resolveSubscription(event: PaddleEvent) {
    const data = event.data;
    if (event.event_type === "transaction.completed") {
      const checkout = await this.repo.getBillingCheckout(String(data.id ?? ""));
      const subscriptionId = String(data.subscription_id ?? "");
      if (!checkout || !subscriptionId) return null;
      return {
        accountId: checkout.account_id,
        subscriptionId,
        customerId: optionalString(data.customer_id),
        plan: checkout.plan as PaidPlan,
        status: "active",
        priceId: checkout.price_id,
        currentPeriodEnd: null,
        scheduledChange: null,
        accountPlan: checkout.plan as AccountPlan,
      };
    }

    if (!event.event_type.startsWith("subscription.")) return null;
    const subscriptionId = String(data.id ?? "");
    if (!subscriptionId) return null;
    const known = await this.repo.getBillingSubscriptionByPaddleId(subscriptionId);
    const originTransactionId = String(data.transaction_id ?? "");
    const checkout = originTransactionId ? await this.repo.getBillingCheckout(originTransactionId) : null;
    const accountId = known?.account_id ?? checkout?.account_id;
    const plan = (known?.plan ?? checkout?.plan) as PaidPlan | undefined;
    const priceId = known?.price_id ?? checkout?.price_id ?? subscriptionPriceId(data);
    if (!accountId || !plan || !priceId) return null;
    const status = String(data.status ?? "active");
    return {
      accountId,
      subscriptionId,
      customerId: optionalString(data.customer_id) ?? known?.paddle_customer_id ?? null,
      plan,
      status,
      priceId,
      currentPeriodEnd: currentPeriodEnd(data),
      scheduledChange: data.scheduled_change ?? null,
      accountPlan: PAID_STATUSES.has(status) ? plan : "free" as AccountPlan,
    };
  }

  private apiBase(): string {
    return this.environment() === "live" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
  }

  private priceId(plan: PaidPlan): string | undefined {
    return plan === "pro" ? this.env.PADDLE_PRICE_PRO : this.env.PADDLE_PRICE_BUSINESS;
  }
}

export async function verifyPaddleSignature(
  rawBody: string,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = header.split(";").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "ts")?.[1];
  const signatures = parts.filter(([key]) => key === "h1").map(([, value]) => value).filter(Boolean) as string[];
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  if (Math.abs(nowSeconds - ts) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}:${rawBody}`));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((signature) => timingSafeHexEqual(signature, expected));
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function subscriptionPriceId(data: Record<string, unknown>): string | null {
  const items = Array.isArray(data.items) ? data.items : [];
  const price = (items[0] as { price?: { id?: unknown } } | undefined)?.price;
  return optionalString(price?.id);
}

function currentPeriodEnd(data: Record<string, unknown>): string | null {
  const period = data.current_billing_period as { ends_at?: unknown } | null | undefined;
  return optionalString(period?.ends_at);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function billingUnavailable(message = "Paddle Billing ещё не настроен"): ApiError {
  return new ApiError(503, "billing_unavailable", message);
}
