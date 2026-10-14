// Verifies long-term rentals against a running server.
//
//   RENTKEEPER_SKIP_MIGRATE=1 AUTH_EXPOSE_CODE=true go run ./cmd/api   # then:
//   node scripts/verify-rentals.mjs
//
// Covers the things a rental can get wrong that a unit test does not reach: that the
// monthly rate survives the wire, that rent is priced by the MONTH rather than by a
// nightly rate multiplied out, that a tenancy is exempt from the advance window while a
// stay is not, and that the year of nights the calendar needs is still materialised.
//
// REQUIRES A FRESH DATABASE. /auth/setup bootstraps the first owner account and only
// works while no user exists; afterwards the script cannot create the account it needs.
// That is a precondition rather than a bug, so it is checked and reported rather than
// failing later with a confusing undefined.
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

/** Add whole calendar months, clamping to the target month's last day. */
function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

const email = `rental-${Date.now()}@example.test`;
const setup = await call("POST", "/auth/setup", { body: { email, accountName: "Аренда" } });
if (setup.status !== 201) {
  console.error(
    `Could not bootstrap an account: /auth/setup returned ${setup.status} ` +
    `(${setup.body?.error?.code ?? "no code"}).\n` +
    "This script needs a FRESH database, because setup only works while no user exists.\n" +
    "  dropdb dombook_rental && createdb dombook_rental\n" +
    "  RENTKEEPER_DSN=... go run ./cmd/migrate up",
  );
  process.exit(2);
}
const send = await call("POST", "/auth/send", { body: { email } });
const token = (await call("POST", "/auth/verify", { body: { email, code: send.body.code } })).body.token;

const place = await call("POST", "/places", { token, body: { name: "Дом", address: "", hasFoodService: false } });
const unitRes = await call("POST", "/units", { token, body: {
  placeId: place.body.place.id, name: "Квартира", capacity: 2,
  basePriceMinor: 5000, depositMinor: 0, monthlyRateMinor: 60000, currency: "AZN" } });
check(unitRes.status === 201, "a unit with a monthly rate is created", `status=${unitRes.status}`);
check(unitRes.body?.unit?.monthlyRateMinor === 60000,
  "the monthly rate survives the wire",
  `monthlyRateMinor=${unitRes.body?.unit?.monthlyRateMinor}`);

const policy = await call("GET", "/account/booking-policy", { token });
check(policy.body.maximumTenancyMonths === 24,
  "the policy reports a tenancy bound separate from the stay bound",
  `maximumTenancyMonths=${policy.body.maximumTenancyMonths} maximumStayMonths=${policy.body.maximumStayMonths}`);

const today = policy.body.today;
const checkIn = addMonths(today, 1);
const checkOut = addMonths(checkIn, 12);

const rental = await call("POST", "/reservations", { token, body: {
  unitId: unitRes.body.unit.id, guestName: "Арендатор",
  checkInDate: checkIn, checkOutDate: checkOut, bookingKind: "rental",
  status: "confirmed", prepaidMinor: 0, depositMinor: 60000, depositStatus: "received" } });
check(rental.status === 201, "a 12-month tenancy starting a month out is accepted",
  `status=${rental.status} code=${rental.body?.error?.code ?? ""}`);

const stored = rental.body?.reservation;
check(stored?.bookingKind === "rental", "the kind round-trips", `bookingKind=${stored?.bookingKind}`);
check(stored?.monthlyRateMinor === 60000, "the rate is captured on the booking",
  `monthlyRateMinor=${stored?.monthlyRateMinor}`);
check(stored?.accommodationMinor === 720000,
  "rent is 12 x 60000, not 365 nights x the nightly rate",
  `accommodationMinor=${stored?.accommodationMinor}; nights x nightly would be ${(stored?.nights?.length ?? 0) * 5000}`);
check(stored?.nights?.length === 365,
  "the year of nights is still materialised, which the calendar reads",
  `nights=${stored?.nights?.length}`);

// A tenancy shorter than one calendar month would price at zero whole months, i.e. a free
// let. It must be refused rather than silently costing nothing.
const tooShort = await call("POST", "/reservations", { token, body: {
  unitId: unitRes.body.unit.id, guestName: "Короткий",
  checkInDate: addMonths(today, 2), checkOutDate: addMonths(today, 2 + 0).slice(0, 8) + String(Number(addMonths(today, 2).slice(8)) + 10).padStart(2, "0"),
  bookingKind: "rental", status: "confirmed", prepaidMinor: 0, depositMinor: 0, depositStatus: "none" } });
check(tooShort.status === 400 && tooShort.body?.error?.code === "rental_too_short",
  "a tenancy shorter than a month is refused, so rent cannot come out as zero",
  `status=${tooShort.status} code=${tooShort.body?.error?.code ?? ""}`);

// The exemption is for rentals only: the same far-out date as a stay must still be refused.
const farStay = await call("POST", "/reservations", { token, body: {
  unitId: unitRes.body.unit.id, guestName: "Гость",
  checkInDate: addMonths(today, 13), checkOutDate: addMonths(today, 14),
  status: "confirmed", prepaidMinor: 0, depositMinor: 0, depositStatus: "none" } });
check(farStay.status === 400 && farStay.body?.error?.code === "check_in_too_far",
  "a stay beyond the advance window is still refused, so the exemption is narrow",
  `status=${farStay.status} code=${farStay.body?.error?.code ?? ""}`);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
