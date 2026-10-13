"use strict";

// The IPC authentication gate.
//
// The renderer hides the workspace behind the login screen, but hiding is presentation. Before
// this gate existed, every data channel answered while signed out: `places.list` returned rows
// and `places.create` WROTE, so anything that could reach the bridge — a compromised renderer,
// DevTools, or a stale window — had the whole local database without signing in.
//
// Found by driving the real app, not by the suite: with the login screen visible, a place was
// created and the toast said so.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");

/** The channel names in the signed-out allowlist. */
function signedOutChannels() {
  const start = MAIN.indexOf("const SIGNED_OUT_CHANNELS = new Set([");
  const end = MAIN.indexOf("]);", start);
  assert.ok(start >= 0 && end > start, "SIGNED_OUT_CHANNELS not found in src/main.cjs");
  const block = MAIN.slice(start, end);
  return new Set([...block.matchAll(/"([a-z]+:[a-zA-Z]+)"/g)].map((m) => m[1]));
}

/** Every channel the main process registers. */
function registeredChannels() {
  return new Set([...MAIN.matchAll(/handle\("([^"]+)"/g)].map((m) => m[1]));
}

test("every channel is either allowlisted or gated", () => {
  const allowed = signedOutChannels();
  const channels = registeredChannels();
  assert.ok(channels.size > 20, `expected the real channel list, found ${channels.size}`);

  // The check is structural: handle() refuses anything not in the allowlist, so there is no
  // third state. What this asserts is that no DATA channel slipped into the allowlist.
  const dataPrefixes = ["places", "properties", "reservations", "calendar", "dashboard",
    "backups", "sync", "entitlements", "bookingPolicy"];
  for (const channel of allowed) {
    const prefix = channel.split(":")[0];
    assert.ok(
      !dataPrefixes.includes(prefix),
      `${channel} is allowlisted but exposes tenant data; signed-out access must be limited to ` +
      "auth, system, and window channels",
    );
  }
});

test("the channels needed to sign in are allowlisted", () => {
  const allowed = signedOutChannels();
  const channels = registeredChannels();

  // The login screen cannot work without these. If one is missing the app is unusable, which
  // is the failure mode the gate introduces.
  const required = ["auth:status", "auth:send", "auth:setup", "auth:verify", "auth:logout", "system:info"];
  for (const channel of required) {
    assert.ok(channels.has(channel), `${channel} is not even registered`);
    assert.ok(allowed.has(channel), `${channel} must work before sign-in`);
  }
});

test("the allowlist names only channels that exist", () => {
  const allowed = signedOutChannels();
  const channels = registeredChannels();

  // A typo here is silent: the intended channel stays gated, and the app breaks on a screen
  // nobody tested.
  for (const channel of allowed) {
    assert.ok(channels.has(channel), `${channel} is allowlisted but never registered — typo?`);
  }
});

test("the gate refuses rather than throwing, and says why", () => {
  // A thrown error would surface as a generic failure; the renderer needs a distinct code so
  // it can return to the login screen instead of showing "something went wrong".
  assert.match(MAIN, /code: "unauthenticated"/, "the gate must report a distinguishable code");
  assert.match(MAIN, /await hasSession\(\)/, "the gate must check the session");
});

test("the session cache is invalidated on sign-in and sign-out", () => {
  // A cached session that outlives a sign-out would keep the gate open; one that outlives a
  // sign-in would keep it shut for up to the cache window.
  assert.match(MAIN, /channel === "auth:verify" \|\| channel === "auth:logout"/,
    "signing in or out must drop the cached session");
});
