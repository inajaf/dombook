// Shared test helpers: an HTTP client that drives the real worker entrypoint
// (src/index.ts) with the pool-provided `env`, plus small fixture builders.
import { env as workerEnv } from "cloudflare:workers";
import { expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { todayInTimeZone, addDaysIso } from "../src/time";

type TestEnv = Env & { TEST_MIGRATIONS: unknown };
const env = workerEnv as unknown as TestEnv;

const ORIGIN = "https://api.dombook.test";

export async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; adminKey?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  headers.set("content-type", "application/json");
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.adminKey) headers.set("authorization", `Bearer ${opts.adminKey}`);
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return worker.fetch(request, env);
}

export async function json<T = unknown>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

// Sign in a brand-new account via the public setup + OTP flow. Returns the
// session token and account id, ready to use for tenant-scoped requests.
// `setupToken` must be supplied for every account after the first (setup is
// gated by SETUP_TOKEN once a user exists).
export async function createAccount(
  email: string,
  accountName = "Тест дом",
  setupToken?: string,
): Promise<{
  token: string;
  accountId: string;
  userId: string;
  code: string;
}> {
  const body: Record<string, unknown> = { email, name: "Владелец", accountName };
  if (setupToken) body.setupToken = setupToken;
  const setup = await api("POST", "/auth/setup", { body });
  expect(setup.status).toBe(201);
  const setupBody = await json<{ accountId: string; user: { id: string } }>(setup);

  const sent = await api("POST", "/auth/send", { body: { email } });
  expect(sent.status).toBe(200);
  const sentBody = await json<{ loginable: boolean; code?: string }>(sent);
  expect(sentBody.loginable).toBe(true);
  expect(typeof sentBody.code).toBe("string");

  const verified = await api("POST", "/auth/verify", { body: { email, code: sentBody.code } });
  expect(verified.status).toBe(200);
  const verifiedBody = await json<{ token: string; accountId: string; user: { id: string } }>(verified);

  return {
    token: verifiedBody.token,
    accountId: verifiedBody.accountId,
    userId: verifiedBody.user.id,
    code: sentBody.code!,
  };
}

export function placePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Кемпинг «Сосновый бор»",
    address: "Азербайджан, Габала",
    hasFoodService: true,
    breakfastPriceMinor: 500,
    lunchPriceMinor: 800,
    dinnerPriceMinor: 700,
    notes: "",
    status: "active",
    ...overrides,
  };
}

export function propertyPayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: "cottage",
    name: "Домик у реки",
    location: "Сектор А",
    capacity: 4,
    basePriceMinor: 6000,
    depositMinor: 2000,
    currency: "AZN",
    checkInTime: "15:00",
    checkOutTime: "11:00",
    notes: "",
    status: "active",
    ...overrides,
  };
}

// A booking window that satisfies the booking policy (check-in today, one
// night stay) for use in reservation payloads.
export function reservationDates(): { checkInDate: string; checkOutDate: string; night: string } {
  const checkInDate = todayInTimeZone();
  const checkOutDate = addDaysIso(checkInDate, 1);
  return { checkInDate, checkOutDate, night: checkInDate };
}

export function reservationPayload(overrides: Record<string, unknown> = {}) {
  const { checkInDate, checkOutDate } = reservationDates();
  return {
    propertyId: "",
    guestName: "Иванов Иван",
    guestPhone: "+994551234567",
    guestEmail: "",
    checkInDate,
    checkOutDate,
    adults: 2,
    children: 0,
    status: "hold",
    prepaidMinor: 0,
    depositMinor: 0,
    depositStatus: "none",
    notes: "",
    mealItems: [],
    ...overrides,
  };
}
