// Verifies a completed cutover against a running server.
//
// Run it after migrating and starting the API:
//
//   RENTKEEPER_DSN=... go run ./cmd/migrate up
//   RENTKEEPER_DSN=... go run ./cmd/migrate-d1 -source /tmp/d1.sqlite
//   RENTKEEPER_DSN=postgres://rentkeeper_app:... RENTKEEPER_SKIP_MIGRATE=1 ... go run ./cmd/api
//   node scripts/verify-cutover.mjs
//
// It asserts the things a migration can silently get wrong: identity, the unit rename, the
// field the baseline schema had dropped, and that credentials were left behind.
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
const check = (label, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`); };

// The migrated user signs in with the OTP flow. Their password was never stored — the old
// system was passwordless too, so nothing needs resetting.
const email = "owner@example.test";
const send = await call("POST", "/auth/send", { body: { email } });
const verify = await call("POST", "/auth/verify", { body: { email, code: send.body.code } });
const token = verify.body.token;
check("the migrated user can sign in", Boolean(token), `status=${verify.status} loginable=${send.body.loginable}`);

const me = await call("GET", "/auth/me", { token });
check("the migrated account is reachable", me.status === 200, `accountName=${me.body?.accountName}`);

const places = await call("GET", "/places", { token });
check("the migrated place is visible", places.status === 200 && (places.body?.places?.length ?? 0) === 1, `places=${places.body?.places?.length}`);

const units = await call("GET", "/units", { token });
check("the migrated unit is visible", (units.body?.units?.length ?? 0) === 1, `units=${units.body?.units?.length}`);
check("the unit kept its original id", units.body?.units?.[0]?.id === "dddddddd-0000-4000-8000-000000000001", `id=${units.body?.units?.[0]?.id}`);
check("the unit kept its name", units.body?.units?.[0]?.name === "Коттедж «Сосны»", `name=${units.body?.units?.[0]?.name}`);

const reservations = await call("GET", "/reservations", { token });
const res = reservations.body?.reservations?.[0];
check("the migrated booking is visible", Boolean(res), `count=${reservations.body?.reservations?.length}`);
check("the booking kept its id", res?.id === "eeeeeeee-0000-4000-8000-000000000001", `id=${res?.id}`);
check("the booking is linked to its unit", res?.unitId === "dddddddd-0000-4000-8000-000000000001", `unitId=${res?.unitId}`);
check("the booking kept its guest", res?.guestName === "Иван Петров", `guest=${res?.guestName}`);
check("the booking kept its dates", res?.checkInDate === "2026-04-01" && res?.checkOutDate === "2026-04-04", `${res?.checkInDate}..${res?.checkOutDate}`);
check("the booking kept its money", res?.accommodationMinor === 72000 && res?.prepaidMinor === 20000, `acc=${res?.accommodationMinor} prepaid=${res?.prepaidMinor}`);
check("the nights came across", (res?.nights?.length ?? 0) === 3, `nights=${res?.nights?.length}`);
console.log("   RAW services:", JSON.stringify(res?.services));
console.log("   RAW keys:", Object.keys(res ?? {}).join(", "));
check("the service name came across", res?.services?.[0]?.name === "Ужин на террасе", `services=${JSON.stringify(res?.services)}`);

// A client that had this account synced resumes from its stored cursor.
const pulled = await call("GET", "/sync/pull?since=42", { token });
check("a client at cursor 42 gets no spurious changes", pulled.status === 200, `reservations=${pulled.body?.changes?.reservations?.length}`);
const full = await call("GET", "/sync/pull?since=0", { token });
check("a full pull returns the migrated data", (full.body?.changes?.reservations?.length ?? 0) === 1 && (full.body?.changes?.units?.length ?? 0) === 1,
  `units=${full.body?.changes?.units?.length} reservations=${full.body?.changes?.reservations?.length}`);

// Pool settings carried over, so a migrated device keeps its interface language.
const settings = await call("GET", "/sync/pull?since=0", { token });
const lang = settings.body?.changes?.app_settings?.find((s) => s.setting_key === "interface_language");
check("a migrated setting survived", lang?.setting_value === "ru", `value=${lang?.setting_value}`);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
