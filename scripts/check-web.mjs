// Boot the WEB build in a real Chromium and fail on any console error.
//
//   npm run build:web && node scripts/check-web.mjs
//
// The web build is a deliverable of its own — a static folder someone can open without the desktop
// app — and nothing tested it. It had NO auth mock at all, so the first call the renderer makes
// (`auth.status()`) threw, and the browser build opened on a login screen nobody could get past:
// no server, no way to receive a code. That is invisible to `npm test`, which never loads a page.
//
// Chromium comes from Electron, which is already a dependency. A second browser would be a second
// download for one check.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "release", "web");
// The path is asked of the package rather than assembled: it differs per platform
// (`Electron.app/Contents/MacOS/Electron` here, `electron` there) and a hardcoded one failed CI
// on Linux with ENOENT the first time this ran.
const ELECTRON = createRequire(import.meta.url)("electron");
// A GUI process on a headless machine is not a failing check, it is a check that cannot run —
// and this is the only step in check-all.sh that needs a display. CI has xvfb; a container may not.
const needsXvfb = process.platform === "linux" && !process.env.DISPLAY;
const hasXvfb = needsXvfb && spawnSync("which", ["xvfb-run"], { stdio: "pipe" }).status === 0;
if (needsXvfb && !hasXvfb) {
  console.log("\n=== Web build ===");
  console.log("  SKIP  нет дисплея и нет xvfb-run — проверить веб-сборку здесь нечем");
  console.log("\nWEB SKIPPED");
  process.exit(0);
}

if (!fs.existsSync(path.join(WEB, "index.html"))) {
  console.error("Нет сборки: сначала npm run build:web");
  process.exit(2);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer((request, response) => {
  const file = path.join(WEB, decodeURIComponent(request.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(request.url.split("?")[0]));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const driver = path.join(ROOT, "scripts", ".check-web-window.cjs");
fs.writeFileSync(driver, `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { contextIsolation: true, sandbox: true } });
  const problems = [];
  win.webContents.on("console-message", (event) => {
    const text = (event && event.message) || "";
    if (event && event.level === "error") problems.push("console: " + text.slice(0, 240));
  });
  win.webContents.on("did-fail-load", (_e, code, description, failed) => problems.push("load " + code + " " + description + " " + failed));
  win.webContents.on("render-process-gone", (_e, details) => problems.push("renderer gone: " + details.reason));
  try {
    await win.loadURL(${JSON.stringify(url)});
    const state = await win.webContents.executeJavaScript(\`
      new Promise((resolve) => setTimeout(() => resolve({
        title: document.title,
        workspace: document.getElementById("loginScreen").classList.contains("is-hidden"),
        account: (document.querySelector("#cloudAccount strong") || {}).textContent || null,
        navItems: document.querySelectorAll(".nav-item").length,
        pages: document.querySelectorAll(".page").length,
        theme: document.documentElement.dataset.theme || null,
      }), 2500))
    \`);
    console.log("RESULT " + JSON.stringify({ state, problems }));
  } catch (error) {
    console.log("RESULT " + JSON.stringify({ state: null, problems: problems.concat(String(error)) }));
  }
  app.exit(0);
});
`);

// Chromium's SUID sandbox helper is owned by the checkout on a CI runner and not setuid, so
// Electron aborts with "The SUID sandbox helper binary was found, but is not configured
// correctly". The page under test is a local file served from 127.0.0.1 by this process, so the
// flag is passed on Linux only — macOS is left exactly as it is.
const flags = process.platform === "linux" ? ["--no-sandbox"] : [];
const command = hasXvfb ? "xvfb-run" : ELECTRON;
const args = hasXvfb ? ["-a", ELECTRON, ...flags, driver] : [...flags, driver];
const child = spawn(command, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const finished = new Promise((resolve) => child.on("exit", resolve));
const timeout = setTimeout(() => child.kill("SIGKILL"), 40_000);
await finished;
clearTimeout(timeout);
fs.rmSync(driver, { force: true });
server.close();

const line = output.split("\n").find((entry) => entry.startsWith("RESULT "));
if (!line) {
  console.error("Веб-сборка не ответила. Вывод:\n" + output.split("\n").slice(-12).join("\n"));
  process.exit(1);
}
const { state, problems } = JSON.parse(line.slice("RESULT ".length));
const checks = [
  [state?.title === "RentKeeper", "окно открывается"],
  [state?.workspace === true, "рабочее место открывается без входа"],
  [Boolean(state?.account), "демо-аккаунт назван"],
  [state?.navItems >= 7, "меню собрано", String(state?.navItems)],
  [state?.pages >= 7, "страницы собраны", String(state?.pages)],
  [problems.length === 0, "в консоли нет ошибок", problems.slice(0, 3).join(" | ")],
];
let ok = true;
console.log("\n=== Web build ===");
for (const [passed, label, detail] of checks) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!passed) ok = false;
}
console.log(ok ? "\nWEB OK" : "\nWEB FAILED");
process.exit(ok ? 0 : 1);
