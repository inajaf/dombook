"use strict";

// Thin HTTP client for the RentKeeper passwordless-auth API, plus JWT session
// persistence. Runs in the Electron main process where global `fetch` is
// available (Electron 43 / Node 18+); no network libraries are used.
//
// Endpoints (see docs/saas-spec.md §5.1). In dev the backend may set
// `AUTH_EXPOSE_CODE=true` so `/auth/send` echoes the one-time code back in
// the response ({ loginable, code? }); the UI surfaces that for local testing
// while production relies on the code being emailed.
//
// The module is dependency-injected (`baseUrl` + `storage`) so the pure parts
// can be exercised from plain Node tests with a fake HTTP backend.

function createAuthApi({ baseUrl, storage }) {
  function httpError(message, status, code) {
    const error = new Error(message);
    error.status = status;
    if (code) error.code = code;
    return error;
  }

  async function request(method, url, body, token) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetch(`${baseUrl}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const wrapped = new Error(
        `Не удалось связаться с сервером (${baseUrl}). Проверьте подключение и запуск RentKeeper API.`,
      );
      wrapped.cause = error;
      wrapped.status = 0;
      throw wrapped;
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const error = new Error(data?.error?.message || `Сервер вернул ошибку (HTTP ${response.status})`);
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    return data;
  }

  async function loadSession() {
    return (await storage.load()) || null;
  }

  async function setup(email) {
    return request("POST", "/auth/setup", { email });
  }

  async function send(email) {
    return request("POST", "/auth/send", { email });
  }

  async function verify(email, code) {
    const data = await request("POST", "/auth/verify", { email, code });
    if (data?.token) {
      await storage.save({
        token: data.token,
        user: data.user,
        accountId: data.accountId,
        accountName: data.accountName,
        plan: data.plan,
      });
    }
    return data;
  }

  // Owner-only plan change via PATCH /account/plan (ships with the phase-2
  // subscriptions backend; against older local APIs it 404s). Saves the
  // returned plan into the stored session and refreshes the rest via /auth/me
  // so the sidebar always reflects the current plan. Errors (including an
  // unsupported backend) propagate for the caller to surface gracefully.
  async function setPlan(plan) {
    const session = await storage.load();
    if (!session?.token) throw httpError("Нет активной сессии", 401);
    const data = await request("PATCH", "/account/plan", { plan }, session.token);
    let refreshed = { ...session, ...data, token: session.token };
    try {
      const me = await request("GET", "/auth/me", undefined, session.token);
      refreshed = { ...refreshed, ...me, token: session.token };
    } catch {
      // /auth/me is best-effort; the PATCH response already carries the plan.
    }
    await storage.save(refreshed);
    return refreshed;
  }

  async function checkout(plan) {
    const session = await storage.load();
    if (!session?.token) throw httpError("Нет активной сессии", 401);
    return request("POST", "/billing/checkout", { plan }, session.token);
  }

  // Validate/refresh the stored session against the backend. Returns the
  // restored session (`user`, `accountId`, `accountName`, `plan`) or null when
  // there is no stored token or the token is rejected/unreachable.
  async function restore() {
    const session = await storage.load();
    if (!session?.token) return null;
    try {
      const data = await request("GET", "/auth/me", undefined, session.token);
      const refreshed = { ...session, ...data, token: session.token };
      await storage.save(refreshed);
      return refreshed;
    } catch (error) {
      if (error?.status === 401) {
        await storage.clear();
        return null;
      }
      throw error;
    }
  }

  /**
   * Send a batch of local changes.
   *
   * Lives here rather than in the sync engine because this module already owns the two
   * things sync needs: the base URL and the stored access token. Duplicating them would
   * mean two places that have to learn about token refresh.
   */
  async function syncPush(payload) {
    const session = await storage.load();
    if (!session?.token) throw httpError("Нет активной сессии", 401);
    return request("POST", "/sync/push", payload, session.token);
  }

  /** Read the account's booking window. */
  async function bookingPolicy() {
    const session = await storage.load();
    if (!session?.token) throw httpError("Нет активной сессии", 401);
    return request("GET", "/account/booking-policy", undefined, session.token);
  }

  /** Change the account's booking window. Owner-only on the server. */
  async function setBookingPolicy(policy) {
    const session = await storage.load();
    if (!session?.token) throw httpError("Нет активной сессии", 401);
    return request("PATCH", "/account/booking-policy", policy, session.token);
  }

  /** Read what the account has paid for. */
  async function entitlements() {
    const session = await storage.load();
    if (!session?.token) throw httpError("Нет активной сессии", 401);
    return request("GET", "/account/entitlements", undefined, session.token);
  }

  /** Read changes after a cursor. */
  async function syncPull(since) {
    const session = await storage.load();
    if (!session?.token) throw httpError("Нет активной сессии", 401);
    return request("GET", `/sync/pull?since=${encodeURIComponent(String(since ?? 0))}`, undefined, session.token);
  }

  async function logout() {
    const session = await storage.load();
    if (session?.token) {
      try {
        await request("POST", "/auth/logout", undefined, session.token);
      } catch {
        // best-effort server revocation; clear the local token regardless
      }
    }
    await storage.clear();
  }

  async function clear() {
    await storage.clear();
  }

  return {
    baseUrl,
    setup,
    send,
    verify,
    setPlan,
    checkout,
    restore,
    bookingPolicy,
    setBookingPolicy,
    entitlements,
    syncPush,
    syncPull,
    logout,
    clear,
    loadSession,
  };
}

module.exports = { createAuthApi };
