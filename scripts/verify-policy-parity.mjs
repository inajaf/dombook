// Verifies that the desktop client and the server judge a booking by the SAME booking window.
//
//   AUTH_EXPOSE_CODE=true go run ./cmd/api   # then:
//   node scripts/verify-policy-parity.mjs
//
// This is a parity check, not a rules check. `tests/booking-policy.test.cjs` proves the
// validator honours a policy it is handed; this proves the two sides are handed the same one.
// They can disagree in a way no unit test sees: the desktop caches the window, and if the cache
// is stale — or never consulted — the client refuses a booking the account is entitled to make,
// with no error anywhere.
//
// Set RENTKEEPER_VERIFY_URL to point at a non-default server.

const BASE = process.env.RENTKEEPER_VERIFY_URL || "http://127.0.0.1:8787";
async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}
const results = [];
const check = (ok, label, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`); };
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const email = `policy-${Date.now()}@example.test`;
await call("POST", "/auth/setup", { body: { email, accountName: "Политика" } });
const send = await call("POST", "/auth/send", { body: { email } });
const token = (await call("POST", "/auth/verify", { body: { email, code: send.body.code } })).body.token;

const place = await call("POST", "/places", { token, body: { name: "База", address: "", hasFoodService: false } });
const unit = await call("POST", "/units", { token, body: { placeId: place.body.place.id, name: "Коттедж", capacity: 4, basePriceMinor: 20000, depositMinor: 0, currency: "AZN" } });

// Fetch the policy once, as a client does, and build dates from ITS "today". The client never
// computes today itself — that is the point of the server returning it.
const policy = await call("GET", "/account/booking-policy", { token });
const today = policy.body.today;
check(policy.body.maximumAdvanceDays === 21, "the account starts on the default window", `advanceDays=${policy.body.maximumAdvanceDays}`);

const book = (ci, co) => call("POST", "/reservations", { token, body: {
  unitId: unit.body.unit.id, guestName: "Гость", checkInDate: ci, checkOutDate: co,
  adults: 1, children: 0, status: "confirmed", totalMinor: 60000, prepaidMinor: 0, depositMinor: 0, depositStatus: "none" } });

const far40 = await book(addDays(today, 40), addDays(today, 43));
check(far40.status === 400 && far40.body?.error?.code === "check_in_too_far",
  "40 days out is refused on the default window", `status=${far40.status} code=${far40.body?.error?.code}`);

const widened = await call("PATCH", "/account/booking-policy", { token, body: { maximumAdvanceDays: 60 } });
check(widened.status === 200 && widened.body.maximumAdvanceDays === 60, "the window is widened to 60", `status=${widened.status}`);
check(widened.body.maximumCheckInDate === addDays(widened.body.today, 60),
  "the server's upper bound follows the widened window", `bound=${widened.body.maximumCheckInDate}`);
check(addDays(today, 40) <= widened.body.maximumCheckInDate,
  "the date the client would allow is inside the window the server reports",
  `checkIn=${addDays(today, 40)} <= bound=${widened.body.maximumCheckInDate}`);

const after = await book(addDays(today, 40), addDays(today, 43));
check(after.status === 201, "the server accepts the booking the client allows", `status=${after.status}`);

await call("PATCH", "/account/booking-policy", { token, body: { maximumAdvanceDays: 7 } });
const narrowed = await book(addDays(today, 10), addDays(today, 12));
check(narrowed.status === 400 && narrowed.body?.error?.code === "check_in_too_far",
  "narrowing the window refuses dates the default allowed", `status=${narrowed.status}`);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
