// Shared helpers for driving the real Electron app over the Chrome DevTools Protocol.
//
// The app is the only thing that can verify the app: the renderer talks to the main process
// over IPC, and the main process talks to PostgreSQL and the sync engine. A test that stubs
// any of those proves nothing about the assembled product, which is why these scripts launch
// the actual binary and click the actual buttons.

import fs from "node:fs";

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

  /** Evaluate an async expression in the renderer and return its value. */
  const evaluate = async (expression) => {
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

  const screenshot = async (file) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  };

  return { close: () => ws.close(), evaluate, send, screenshot };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
