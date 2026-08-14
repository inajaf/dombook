const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createAuthApi } = require("../src/main/auth.cjs");

// Minimal in-memory session store (mirrors auth-session.cjs round-trip).
function memoryStore() {
  const store = { current: null };
  return Object.assign(store, {
    save: async (session) => { store.current = session; },
    load: async () => store.current,
    clear: async () => { store.current = null; },
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("setPlan вызывает PATCH /account/plan и сохраняет обновлённый план в сессии", async () => {
  const store = memoryStore();
  let patchBody = null;
  let patchAuth = null;
  let meAuth = null;
  const { server, baseUrl } = await startServer(async (req, res) => {
    if (req.method === "PATCH" && req.url === "/account/plan") {
      patchAuth = req.headers.authorization;
      patchBody = await readBody(req);
      json(res, 200, { user: { email: "a@b.com" }, accountId: "acct-1", accountName: "Тест", plan: "business" });
      return;
    }
    if (req.method === "GET" && req.url === "/auth/me") {
      meAuth = req.headers.authorization;
      json(res, 200, { user: { email: "a@b.com" }, accountId: "acct-1", accountName: "Тест", plan: "business" });
      return;
    }
    json(res, 404, { error: { message: "not found" } });
  });

  const api = createAuthApi({ baseUrl, storage: store });
  await store.save({ token: "jwt-plan", user: { email: "a@b.com" }, accountId: "acct-1", accountName: "Тест", plan: "free" });
  const updated = await api.setPlan("business");
  assert.equal(patchAuth, "Bearer jwt-plan");
  assert.deepEqual(patchBody, { plan: "business" });
  assert.equal(meAuth, "Bearer jwt-plan", "после PATCH план освежается через /auth/me");
  assert.equal(updated.plan, "business");
  assert.equal(store.current.plan, "business");
  assert.equal(store.current.token, "jwt-plan");
  server.close();
});

test("setPlan без сохранённой сессии возвращает ошибку 401", async () => {
  const store = memoryStore();
  const { server, baseUrl } = await startServer(() => {
    assert.fail("без токена сервер не должен вызываться");
  });
  const api = createAuthApi({ baseUrl, storage: store });
  const error = await api.setPlan("business").then(() => null, (e) => e);
  assert.equal(error.status, 401);
  server.close();
});

test("setPlan пробрасывает ошибки (например 404 от бэкенда без PATCH /account/plan)", async () => {
  const store = memoryStore();
  const { server, baseUrl } = await startServer((req, res) => {
    json(res, 404, { error: { message: "not found" } });
  });
  const api = createAuthApi({ baseUrl, storage: store });
  await store.save({ token: "jwt-plan" });
  const error = await api.setPlan("business").then(() => null, (e) => e);
  assert.equal(error.status, 404);
  assert.equal(store.current.token, "jwt-plan", "сессия не должна теряться при неудачном PATCH");
  server.close();
});

test("send возвращает dev-код при AUTH_EXPOSE_CODE", async () => {
  const { server, baseUrl } = await startServer(async (req, res) => {
    let body = {};
    if (req.method === "POST" && req.url === "/auth/send") {
      body = await readBody(req);
      json(res, 200, { ok: true, loginable: true, code: "123456" });
      return;
    }
    assert.fail(`неожиданный запрос ${req.method} ${req.url} (${JSON.stringify(body)})`);
  });

  const api = createAuthApi({ baseUrl, storage: memoryStore() });
  const out = await api.send("owner@example.com");
  assert.equal(out.loginable, true);
  assert.equal(out.code, "123456");
  server.close();
});

test("verify сохраняет JWT-сессию и restore() возвращает её через /auth/me", async () => {
  const store = memoryStore();
  let meAuth = null;
  const { server, baseUrl } = await startServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/auth/verify") {
      const body = await readBody(req);
      assert.equal(body.code, "111222");
      json(res, 200, { token: "jwt-1", user: { email: "a@b.com" }, accountId: "acct-1", accountName: "Тест", plan: "free", inviteAccepted: false });
      return;
    }
    if (req.method === "GET" && req.url === "/auth/me") {
      meAuth = req.headers.authorization;
      json(res, 200, { user: { email: "a@b.com" }, accountId: "acct-1", accountName: "Тест", plan: "free" });
      return;
    }
    json(res, 404, { error: { message: "not found" } });
  });

  const api = createAuthApi({ baseUrl, storage: store });
  await api.verify("a@b.com", "111222");
  assert.equal(store.current.token, "jwt-1");

  const restored = await api.restore();
  assert.equal(meAuth, "Bearer jwt-1");
  assert.equal(restored.user.email, "a@b.com");
  assert.equal(restored.plan, "free");
  assert.equal(store.current.token, "jwt-1", "restore не должен терять токен");
  server.close();
});

test("restore() без сохранённой сессии возвращает null без обращения к серверу", async () => {
  let hitServer = false;
  const { server, baseUrl } = await startServer((req, res) => {
    hitServer = true;
    json(res, 200, {});
  });
  const api = createAuthApi({ baseUrl, storage: memoryStore() });
  assert.equal(await api.restore(), null);
  assert.equal(hitServer, false);
  server.close();
});

test("restore() чистит локальный токен при 401 от /auth/me", async () => {
  const store = memoryStore();
  const { server, baseUrl } = await startServer((req, res) => {
    if (req.method === "GET" && req.url === "/auth/me") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unauthorized" } }));
      return;
    }
    json(res, 404, { error: { message: "not found" } });
  });

  const api = createAuthApi({ baseUrl, storage: store });
  await store.save({ token: "expired", user: { email: "x" } });
  assert.equal(await api.restore(), null);
  assert.equal(store.current, null, "токен должен быть удалён после 401");
  server.close();
});

test("logout вызывает /auth/logout и очищает локальную сессию", async () => {
  const store = memoryStore();
  let loggedOut = false;
  const { server, baseUrl } = await startServer((req, res) => {
    if (req.method === "POST" && req.url === "/auth/logout") {
      loggedOut = true;
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: { message: "not found" } });
  });

  const api = createAuthApi({ baseUrl, storage: store });
  await store.save({ token: "jwt-9" });
  await api.logout();
  assert.equal(loggedOut, true);
  assert.equal(store.current, null);
  server.close();
});

test("сетевой сбой возвращает понятную ошибку со статусом 0", async () => {
  const store = memoryStore();
  const { server, baseUrl } = await startServer(() => {});
  server.close(); // закрыли сразу -> fetch заведомо не сможет подключиться

  const api = createAuthApi({ baseUrl, storage: store });
  const error = await api.send("a@b.com").then(() => null, (e) => e);
  assert.ok(error instanceof Error);
  assert.equal(error.status, 0);
  assert.match(error.message, /Не удалось связаться с сервером/);
});
