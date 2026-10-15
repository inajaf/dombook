// Sync: does the user's work actually reach the server, and does it come back?
//
//   scripts/e2e-stack.sh up && node scripts/e2e-sync.mjs
//
// This suite exists because sync had NEVER been observed to succeed. Three separate faults
// made it fail on every attempt, and none was visible to a unit test:
//
//   1. The desktop schema had no conflict_code / conflict_details / resolved_at, so the very
//      first pull threw "table reservations has no column named conflict_code".
//   2. A refused push still ran the pull, which deleted the outbox entries of the rows it
//      applied — so the user's unsent changes were erased from both sides.
//   3. The demo seed created more units than a free account allows, so the first push was
//      refused by the entitlement trigger and the transaction aborted as a whole.
//
// The account here stays WITHIN the free allowance on purpose: an over-allowance account
// cannot sync by design, and testing that would hide whether sync works at all.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { connect, freshStart, killApp, psqlArgs, psqlEnv, reporter, restartApp, wait } from "./e2e-lib.mjs";

let app = await connect();
const { check, finish } = reporter("Sync");

const submit = (id) => app.evaluate(`
  const f = document.getElementById(${JSON.stringify(id)});
  const b = f.querySelector('button[type="submit"]');
  if (b) b.click(); else f.requestSubmit();
  return 'ok';
`);

app = await freshStart(app);
check(true, "the app restarted on a clean profile");

const email = `sync-${Date.now()}@example.test`;
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await submit("loginEmailForm");
await wait(3000);
const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g, '') : '';`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await submit("loginCodeForm");
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(3000);
}
check(await app.evaluate(`return document.getElementById('loginScreen').classList.contains('is-hidden')`), "signed in");

// --- The app syncs on its own after a sign-in -----------------------------
//
// Nothing here calls sync.now(). The screen reads the LOCAL database, so on a fresh profile an
// owner who signs in sees an empty workspace until something fetches the server's copy — and the
// only things that did were a 60-second timer and a button in Settings. "I logged in and all my
// bookings are gone" is what that looks like, and it happened to the owner on this machine.
//
// The suite used to reach its first sync through drain(), which calls sync.now() itself, so it
// could never have noticed.
await wait(6000);
const automatic = await app.evaluate(`return (await window.domBook.sync.status()).data`);
check(automatic.lastResult !== null,
  "the app syncs by itself after signing in, without pressing anything",
  `last=${automatic.lastResult?.at ?? "never"}`);
check(automatic.pending === automatic.stuck,
  "the automatic sync drains the queue it inherited",
  `pending=${automatic.pending} stuck=${automatic.stuck}`);

/** Push until nothing retryable is left, reporting the last result. */
async function drain(attempts = 6) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const status = await app.evaluate(`return (await window.domBook.sync.status()).data`);
    // `stuck` counts rows the server refused for good. They stay queued by design, so the
    // queue is "drained" when only stuck rows remain.
    if (status.pending === status.stuck) break;
    last = await app.evaluate(`return await window.domBook.sync.now()`);
    await wait(400);
    if (i === 0) return last?.data ?? null;
  }
  return last?.data ?? null;
}

// --- The first sync: the seeded demo, which fits the free allowance ---------
//
// `drain()` returns null when there is nothing left to drain, which is now the COMMON case: the
// app syncs by itself the moment the workspace opens, so by the time this runs the seed has been
// pushed and the queue is already empty. The evidence for "the first sync succeeded" is then the
// recorded result rather than a new one — the assertion is unchanged, its source is not.
const first = await drain()
  ?? await app.evaluate(`return (await window.domBook.sync.status()).data.lastResult`);
const firstStatus = await app.evaluate(`return (await window.domBook.sync.status()).data`);
check(first?.ok === true, "the first sync succeeds", `error=${first?.error ?? "none"}`);
check((first?.pushed ?? 0) > 0, "it pushes the seeded data", `pushed=${first?.pushed}`);
check((firstStatus.cursor ?? 0) > 0, "the pull cursor advances past zero", `cursor=${firstStatus.cursor}`);
// Rows the server refuses for good stay queued and are counted as stuck — visible, not lost.
check((firstStatus.stuck ?? 0) === 0, "nothing is stuck on this account", `stuck=${firstStatus.stuck}`);
check(firstStatus.pending === firstStatus.stuck, "the queue drains",
  `pending=${firstStatus.pending} stuck=${firstStatus.stuck}`);

// --- A booking made now must reach the server -----------------------------
const booking = await app.evaluate(`
  const today = (await window.domBook.system.info()).data.bookingPolicy.today;
  const add = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const p = activeProperties()[0];
  const b = await window.domBook.reservations.create({ propertyId: p.id, guestName: 'Синхронизируемый гость',
    checkInDate: add(today, 3), checkOutDate: add(today, 6), status: 'confirmed',
    prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 2, children: 0 });
  await refreshCore();
  return { ok: b.ok, id: b.data?.id, unitId: p.id, error: b.error };
`);
check(booking.ok === true, "a booking is made", `error=${booking.error ?? "none"}`);

const afterBooking = await app.evaluate(`return (await window.domBook.sync.status()).data.pending`);
check(afterBooking > 0, "the booking is queued", `pending=${afterBooking}`);

const second = await drain();
check(second?.ok === true, "the booking syncs", `error=${second?.error ?? "none"}`);
const remaining = await app.evaluate(`return (await window.domBook.sync.status()).data`);
check(remaining.pending === remaining.stuck, "the queue is clear afterwards",
  `pending=${remaining.pending} stuck=${remaining.stuck}`);

// --- The server must hold the nights, not just the booking ----------------
// A booking that reaches the server without its nights blocks nothing there, so the unit
// reads as free on every other device. Checked against PostgreSQL directly: the renderer
// cannot reach the API cross-origin, and the point is what the SERVER stored.
const nights = Number(execFileSync("psql", psqlArgs([
  "-t", "-A", "-c",
  "SELECT COUNT(*) FROM reservation_nights WHERE tenant_id = (SELECT id FROM accounts ORDER BY created_at DESC LIMIT 1)",
]), { env: psqlEnv() }).toString().trim());
check(nights >= 3, "the booking's nights reached the server, not just the booking", `server nights=${nights}`);

// --- A second sync with nothing to send must still be ok ------------------
const idle = await app.evaluate(`return await window.domBook.sync.now()`);
check(idle.data?.ok === true, "an idle sync is successful too", `error=${idle.data?.error ?? "none"}`);
check((idle.data?.pushed ?? 0) === 0, "an idle sync pushes nothing", `pushed=${idle.data?.pushed}`);

// --- The same account on a SECOND DEVICE ---------------------------------
//
// The profile is thrown away but the server is NOT reset, so this is a device that has never seen
// this account. It used to be broken in the worst possible way: the fresh installation created the
// demo sample, pushed it at an account that already had a unit of the same name, was refused
// ("Такое название уже используется"), and — because a refused push skips the pull — never
// received the account's data at all. It showed the sample and nothing else, forever. The same
// thing happened to any device whose profile had been recreated.
//
// A signup and a second device look identical from inside the app: an empty database and an
// address just typed. What separates them is whether the sign-in CREATED the account, which is
// why the renderer reports that and the main process acts on it.
killApp();
await wait(1500);
fs.rmSync(`${os.homedir()}/Library/Application Support/rentkeeper-desktop`, { recursive: true, force: true });
app = await restartApp(null);
check(true, "the device is wiped, the account is not");

// The send throttle allows one code per address per minute, and this is the second request for the
// same address in the same run. Waiting it out is part of the flow, not a workaround: a real user
// signing back in within a minute meets exactly this.
let secondCode = "";
for (let attempt = 1; attempt <= 3 && !secondCode; attempt += 1) {
  await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
  await submit("loginEmailForm");
  await wait(3000);
  const state = await app.evaluate(`
    const error = document.getElementById('loginEmailError');
    const hint = document.getElementById('loginCodeHint');
    return {
      error: error && !error.hidden ? error.textContent : '',
      hint: hint && !hint.hidden ? hint.textContent : '',
    };
  `);
  secondCode = state.hint.replace(/\D/g, "");
  if (!secondCode && /част/i.test(state.error)) await wait(45000);
}
check(secondCode.length === 6, "a code can be requested again for the same address", `code=${secondCode ? "yes" : "no"}`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(secondCode)}; return 'ok';`);
await submit("loginCodeForm");
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(3000);
}
// The app pulls by itself; give it the same moment the first sign-in got.
await wait(8000);
const arrived = await app.evaluate(`
  const bridge = window.domBook;
  const units = await bridge.properties.list();
  const reservations = await bridge.reservations.list();
  const sync = await bridge.sync.status();
  return {
    units: (units.data || []).map((u) => u.name),
    guests: (reservations.data || []).map((r) => r.guest_name),
    error: sync.data?.lastResult?.error || null,
  };
`);
check(arrived.guests.includes("Синхронизируемый гость"),
  "the second device receives the account's bookings, not just its own sample",
  JSON.stringify(arrived.guests));
check(arrived.error === null,
  "and it syncs, instead of colliding with the sample it created on startup",
  String(arrived.error));

const ok = finish();
console.log(ok ? "SYNC OK" : "SYNC FAILED");
app.close();
process.exit(ok ? 0 : 1);
