// Shared helpers for driving the real Electron app over the Chrome DevTools Protocol.
//
// The app is the only thing that can verify the app: the renderer talks to the main process
// over IPC, and the main process talks to PostgreSQL and the sync engine. A test that stubs
// any of those proves nothing about the assembled product, which is why these scripts launch
// the actual binary and click the actual buttons.

import fs from "node:fs";
import { createRequire } from "node:module";

const PORT = process.env.CDP_PORT || "9555";

/** Attach to the running app's renderer. */
export async function connect() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page" && t.url.includes("index.html"));
  if (!page) throw new Error(`no renderer page on ${PORT}; is the app running?`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  /**
   * Evaluate an async expression in the renderer and return its value.
   *
   * "Promise was collected" is a Chrome quirk, not a page error: the inspector drops a pending
   * promise when the renderer is busy, which happens on the longer scenario blocks. It looks
   * identical to a crash, so it is retried rather than reported — a genuine page exception
   * still throws on the first attempt.
   */
  const evaluateOnce = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error("page error: " + (result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)));
    }
    return result.result.value;
  };

  const evaluate = async (expression) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await evaluateOnce(expression);
      } catch (error) {
        const collected = /Promise was collected/.test(error.message);
        if (!collected || attempt >= 3) throw error;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  };

  const screenshot = async (file) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  };

  return { close: () => ws.close(), evaluate, send, screenshot };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reset BOTH sides, so a suite starts from a genuinely empty state.
 *
 * Setup only works while no user exists, so ANY suite that signs up is not repeatable without
 * the server half: the second run gets 403 "registration is closed" and reports it as a
 * failure of whatever it was actually testing.
 *
 * The device half matters just as much. A previous run leaves rows in the local outbox, and
 * those rows reference a tenant that no longer exists, so the next run's sync is refused with
 * "4 changes were not accepted" — a leftover, reported as a sync bug. Removing the profile
 * also forces a fresh demo seed, which the suites then know the shape of.
 *
 * Call it before signing up, never in the middle of a run.
 */
export async function resetAuthState({ app = null } = {}) {
  const { execFileSync } = createRequire(import.meta.url)("node:child_process");
  const env = { ...process.env, PATH: `/opt/homebrew/opt/postgresql@16/bin:${process.env.PATH}` };
  // TRUNCATE ... CASCADE reaches the tenant tables through their account foreign key, so the
  // previous run's bookings, units and places go too. That matters: truncating ONLY the auth
  // tables leaves the old tenant data on the server, the fresh client pulls it back down, and
  // its rows then collide with the new run's — a booking refused as "already occupied" by a
  // row the suite never created in this run.
  execFileSync("psql", ["-d", process.env.DOMBOOK_E2E_DB || "dombook_e2e", "-q", "-v", "ON_ERROR_STOP=1", "-c",
    "TRUNCATE users, accounts, verification_codes, sessions, invites, devices RESTART IDENTITY CASCADE;",
  ], { env, stdio: "pipe" });

  // The parent tables are truncated explicitly as well as by cascade. Belt and braces: if a
  // future migration removes the cascade path, the suite would silently start reusing the
  // previous run's bookings — which surfaces as "already occupied" for a row this run never
  // created, i.e. exactly like a product bug.
  try {
    execFileSync("psql", ["-d", process.env.DOMBOOK_E2E_DB || "dombook_e2e", "-q", "-v", "ON_ERROR_STOP=1", "-c",
      "TRUNCATE reservation_nights, reservation_services, reservation_meals, reservations, units, places, app_settings, audit_log, tenant_state RESTART IDENTITY CASCADE;",
    ], { env, stdio: "pipe" });
  } catch (error) {
    // Loud on purpose: a silent failure here leaves the previous run's data on the server,
    // the fresh client pulls it back, and later assertions report it as a product bug.
    console.error("[reset] tenant truncate failed:", String(error.stderr ?? error.message).slice(0, 200));
  }

  // The local profile, so the outbox and cached session start empty too.
  const os = createRequire(import.meta.url)("node:os");
  const fsSync = createRequire(import.meta.url)("node:fs");
  fsSync.rmSync(`${os.homedir()}/Library/Application Support/rentkeeper-desktop`, { recursive: true, force: true });
  fsSync.rmSync(`${os.homedir()}/Library/Application Support/dombook-desktop`, { recursive: true, force: true });
}

/** Stop every Electron process and wait until the CDP port is actually free. */
export function killApp() {
  const { execFileSync } = createRequire(import.meta.url)("node:child_process");
  for (const pattern of [
    "electron/dist/Electron.app/Contents/MacOS/Electron",
    "MacOS/Electron Helper",
    "MacOS/Electron",
  ]) {
    try { execFileSync("pkill", ["-9", "-f", pattern], { stdio: "pipe" }); } catch { /* none running */ }
  }
}

/** Wait until nothing is listening on the debug port, or give up after ~10s. */
async function waitForPortFree(port) {
  for (let i = 0; i < 40; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) });
    } catch {
      return true; // nothing answered: the port is free
    }
    await wait(250);
  }
  return false;
}

/**
 * Reset everything and hand back a connection to a freshly started app.
 *
 * Suites MUST use this rather than calling resetAuthState() and hoping the running app
 * notices. The app opens its SQLite file at startup and keeps answering from it, so removing
 * the profile underneath it leaves a process writing to a deleted file — and the suite then
 * fails in confusing ways (a new booking refused because a previous run's booking still holds
 * the dates). Restarting is the only reliable boundary between runs.
 */
export async function freshStart(app) {
  // Order matters. The app keeps its whole database in memory and rewrites the file on every
  // persist AND on exit, so deleting the profile while it is running leaves the old data on
  // disk moments later — and the next run silently reuses it. That produced a booking refused
  // as "already occupied" by the PREVIOUS run's booking, which looks exactly like a product
  // bug. Stop the process first, wait for the port to free, and only then delete.
  try { app?.close(); } catch { /* already gone */ }
  killApp();
  await waitForPortFree(PORT);
  await resetAuthState();
  return restartApp(null);
}

/** A reporter that prints, counts, and can fail the process. */
export function reporter(title) {
  const results = [];
  console.log(`\n=== ${title} ===`);
  const check = (ok, label, detail = "") => {
    results.push({ ok, label });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
    return ok;
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      console.log("  failed:");
      for (const f of failed) console.log(`    - ${f.label}`);
    }
    return failed.length === 0;
  };
  return { check, finish, results };
}

/**
 * Restart the desktop app and return a connection to the new renderer.
 *
 * Needed whenever the profile directory is removed: the running process still holds the file
 * it opened at startup, and keeps answering from it, so a suite that resets the profile would
 * silently test the OLD database.
 */
export async function restartApp(previous = null) {
  const { spawn, execFileSync } = createRequire(import.meta.url)("node:child_process");
  const fsSync = createRequire(import.meta.url)("node:fs");
  const root = process.env.DOMBOOK_ROOT || process.cwd();
  const port = process.env.DOMBOOK_E2E_PORT || "8787";

  try { previous?.close(); } catch { /* already gone */ }
  killApp();
  await waitForPortFree(PORT);

  const env = { ...process.env, DOMBOOK_API_URL: `http://127.0.0.1:${port}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fsSync.openSync("/tmp/e2e-app.log", "w");
  spawn(`${root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
    [root, `--remote-debugging-port=${PORT}`], { env, detached: true, stdio: ["ignore", log, log] }).unref();

  for (let i = 0; i < 40; i += 1) {
    await wait(500);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      if (list.some((t) => t.type === "page" && t.url.includes("index.html"))) { await wait(2000); return connect(); }
    } catch { /* not up yet */ }
  }
  throw new Error("the app did not come back up; see /tmp/e2e-app.log");
}

/** Add whole calendar months, clamping to the target month's last day. */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
