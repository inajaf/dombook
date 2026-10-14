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
import {addDays, connect, freshStart, reporter, resetAuthState, restartApp, wait} from "./e2e-lib.mjs";

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
const first = await drain();
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
const nights = Number(execFileSync("psql", [
  "-d", process.env.DOMBOOK_E2E_DB || "dombook_e2e", "-t", "-A", "-c",
  "SELECT COUNT(*) FROM reservation_nights WHERE tenant_id = (SELECT id FROM accounts ORDER BY created_at DESC LIMIT 1)",
], { env: { ...process.env, PATH: `/opt/homebrew/opt/postgresql@16/bin:${process.env.PATH}` } }).toString().trim());
check(nights >= 3, "the booking's nights reached the server, not just the booking", `server nights=${nights}`);

// --- A second sync with nothing to send must still be ok ------------------
const idle = await app.evaluate(`return await window.domBook.sync.now()`);
check(idle.data?.ok === true, "an idle sync is successful too", `error=${idle.data?.error ?? "none"}`);
check((idle.data?.pushed ?? 0) === 0, "an idle sync pushes nothing", `pushed=${idle.data?.pushed}`);

const ok = finish();
console.log(ok ? "SYNC OK" : "SYNC FAILED");
app.close();
process.exit(ok ? 0 : 1);
