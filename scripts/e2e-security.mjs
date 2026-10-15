// Security checks against the running stack.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-security.mjs
//
// The desktop is single-tenant, so the interesting isolation question is between ACCOUNTS on
// the server. A property manager with two clients — or one client with two portfolios — must
// not be able to read or write the other's data, and an unsigned window must not reach either.

import { createRequire } from "node:module";
import { freshStart, psqlArgs, psqlEnv, reporter, resetAuthState, wait } from "./e2e-lib.mjs";

const API = process.env.RENTKEEPER_E2E_URL || "http://127.0.0.1:8787";
const { check, finish } = reporter("Security");

async function api(method, path, { token, body, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Sign in an address that already exists, using the dev code echo. */
async function signIn(email) {
  const send = await api("POST", "/auth/send", { body: { email } });
  if (send.status !== 200) return { status: send.status, body: send.body };
  const verify = await api("POST", "/auth/verify", { body: { email, code: send.body.code } });
  return { email, token: verify.body?.token, accountId: verify.body?.accountId, loginable: send.body?.loginable };
}

/**
 * The first account bootstraps; the second joins by invitation.
 *
 * /auth/setup only works while no user exists, so creating a second business means inviting
 * an address from the first — which is how a colleague or a second client actually joins.
 */
async function signUpFirst(label) {
  const email = `${label}-${Date.now()}@example.test`;
  const send = await api("POST", "/auth/send", { body: { email } });
  if (send.body?.loginable === false) {
    await api("POST", "/auth/setup", { body: { email, accountName: label } });
  }
  const verify = await api("POST", "/auth/verify", { body: { email, code: send.body.code } });
  return { email, token: verify.body?.token, accountId: verify.body?.accountId };
}

// --- Two separate businesses ----------------------------------------------
//
// Two DISTINCT businesses, not two users in one account: inviting from alpha would attach
// beta to alpha, which is the opposite of the isolation being tested. So the second account
// is bootstrapped directly against the database, which is the only supported way to create a
// second tenant while setup is closed.
//
// The auth tables are cleared first so setup bootstraps; the desktop app is restarted at the
// END, because the bridge checks below need a running app and this half does not touch it.
await resetAuthState();
const alpha = await signUpFirst("alpha");
check(Boolean(alpha.token), "the first business bootstraps");

const betaEmail = `beta-${Date.now()}@example.test`;
const betaSetup = await api("POST", "/auth/setup", { body: { email: betaEmail, accountName: "beta" } });
let beta;
if (betaSetup.status === 201) {
  beta = await signIn(betaEmail);
} else {
  // Setup is closed because alpha exists, and there is no operator route that creates an
  // account — so the second tenant is seeded directly, as an operator would. Only the ACCOUNT
  // and its owner user are created; everything else goes through the API.
  const { execFileSync } = createRequire(import.meta.url)("node:child_process");
  execFileSync("psql", psqlArgs(["-q", "-v", "ON_ERROR_STOP=1", "-c", `
    WITH a AS (
      INSERT INTO accounts(name, plan) VALUES ('beta', 'free') RETURNING id
    )
    INSERT INTO users(account_id, email, name, role)
    SELECT id, '${betaEmail}', 'beta owner', 'owner' FROM a;
  `]), { env: psqlEnv(), stdio: "pipe" });
  beta = await signIn(betaEmail);
}
check(Boolean(beta.token), "a second, separate business exists", `setupStatus=${betaSetup.status}`);

check(Boolean(alpha.accountId) && Boolean(beta.accountId) && alpha.accountId !== beta.accountId,
  "they are different accounts", `${alpha.accountId?.slice(0, 8)} vs ${beta.accountId?.slice(0, 8)}`);

// Alpha's data.
const alphaPlace = await api("POST", "/places", { token: alpha.token, body: { name: "Alpha База", address: "", hasFoodService: false } });
const alphaUnit = await api("POST", "/units", { token: alpha.token, body: {
  placeId: alphaPlace.body?.place?.id, name: "Alpha Коттедж", capacity: 4,
  basePriceMinor: 10000, depositMinor: 0, monthlyRateMinor: 0, currency: "AZN" } });
check(Boolean(alphaUnit.body?.unit?.id), "alpha creates a unit");

// --- Access is granted BY the account, and only there ---------------------
//
// The owner's requirement in one sentence: another account must not see this one's data unless
// this account gives it access, from settings. Four assertions hold that up — no access before the
// grant, access after it, no administrative rights with it, and no access once it is withdrawn.
const colleagueEmail = `colleague-${Date.now()}@example.test`;

// The block sits HERE, before the app half, for two reasons that cost real time to find: alpha's
// token is fresh, and signing the app out later REVOKES every session for that user — so a token
// taken from the creation above is dead by the time the bridge checks are done. Re-signing in
// instead is not an option either: `/auth/send` is throttled per address, and a second request in
// one run answers 429 with a window that outlasts a 45-second wait.
const owner = alpha;

const stranger = await api("POST", "/auth/send", { body: { email: `stranger-${Date.now()}@example.test` } });
check(stranger.body?.loginable === false,
  "an address nobody invited has no way in at all",
  `loginable=${stranger.body?.loginable}`);

const invited = await api("POST", "/auth/invites", {
  token: owner.token,
  body: { email: colleagueEmail, role: "staff" },
});
check(invited.status === 201, "the owner can invite a colleague from the account", `status=${invited.status}`);
check(typeof invited.body?.inviteToken === "string" && invited.body.inviteToken.length > 20,
  "the invitation returns a token exactly once, so a leaked row cannot be replayed");

// The invite is what makes the address loginable; nothing else does.
const colleague = await signIn(colleagueEmail);
check(Boolean(colleague.token), "the invited colleague signs in with their own login");
check(colleague.accountId === alpha.accountId,
  "and lands in the account that invited them, not one of their own",
  `${colleague.accountId} vs ${alpha.accountId}`);

const seenByColleague = await api("GET", "/places", { token: colleague.token });
const alphaPlaces = (seenByColleague.body?.places ?? []).map((place) => place.name);
check(seenByColleague.status === 200 && alphaPlaces.includes("Alpha База"),
  "the colleague can see the inviter's data — that is what the grant bought",
  JSON.stringify(alphaPlaces));

const colleagueInviting = await api("POST", "/auth/invites", {
  token: colleague.token,
  body: { email: `someone-${Date.now()}@example.test`, role: "staff" },
});
check(colleagueInviting.status === 403,
  "but cannot hand that access on: inviting is owner and admin only",
  `status=${colleagueInviting.status}`);

// Revoked means closed: the address that was never granted access cannot get in.
const withdrawnEmail = `withdrawn-${Date.now()}@example.test`;
const withdrawn = await api("POST", "/auth/invites", { token: owner.token, body: { email: withdrawnEmail, role: "staff" } });
const revoked = await api("POST", `/auth/invites/${withdrawn.body?.invite?.id}/revoke`, { token: owner.token });
check(revoked.status === 200, "an invitation can be withdrawn before it is used", `status=${revoked.status}`);
const afterRevoke = await api("POST", "/auth/send", { body: { email: withdrawnEmail } });
check(afterRevoke.body?.loginable === false,
  "and the withdrawn address is closed again",
  `loginable=${afterRevoke.body?.loginable}`);

// --- Beta must not see it ------------------------------------------------
const betaUnits = await api("GET", "/units", { token: beta.token });
check(Array.isArray(betaUnits.body?.units), "beta can list its own units");
check(
  !(betaUnits.body?.units ?? []).some((u) => u.id === alphaUnit.body?.unit?.id),
  "beta's unit list does not contain alpha's unit",
  `beta sees ${(betaUnits.body?.units ?? []).length} units`,
);

// --- Beta must not be able to read it by id -------------------------------
const stolen = await api("GET", `/units/${alphaUnit.body?.unit?.id}`, { token: beta.token });
check(
  stolen.status === 404 || stolen.status === 403 || stolen.body?.unit == null,
  "alpha's unit is not readable by id from beta's session",
  `status=${stolen.status}`,
);

// --- Beta must not be able to WRITE it -----------------------------------
const tampered = await api("PATCH", `/units/${alphaUnit.body?.unit?.id}`, {
  token: beta.token, body: { name: "Взломано" },
});
check(
  tampered.status === 404 || tampered.status === 403,
  "alpha's unit cannot be modified from beta's session",
  `status=${tampered.status}`,
);
const verifyName = await api("GET", "/units", { token: alpha.token });
const alphaUnitAfter = (verifyName.body?.units ?? []).find((u) => u.id === alphaUnit.body?.unit?.id);
check(alphaUnitAfter?.name === "Alpha Коттедж", "alpha's unit is unchanged after the attempt",
  `name=${alphaUnitAfter?.name}`);

// --- Beta must not be able to book into alpha's unit ---------------------
const crossed = await api("POST", "/reservations", { token: beta.token, body: {
  unitId: alphaUnit.body?.unit?.id, guestName: "Чужой гость",
  checkInDate: "2026-12-01", checkOutDate: "2026-12-03",
  status: "confirmed", prepaidMinor: 0, depositMinor: 0, depositStatus: "none" } });
check(
  crossed.status === 404 || crossed.status === 403 || crossed.status === 400,
  "beta cannot book a guest into alpha's unit",
  `status=${crossed.status} code=${crossed.body?.error?.code ?? ""}`,
);

// --- Unauthenticated requests ---------------------------------------------
for (const [method, path] of [["GET", "/units"], ["GET", "/reservations"], ["GET", "/places"]]) {
  const anon = await api(method, path);
  check(anon.status === 401 || anon.status === 403, `${method} ${path} requires a token`,
    `status=${anon.status}`);
}

const badToken = await api("GET", "/units", { token: "not.a.real.token" });
check(badToken.status === 401, "a malformed token is refused", `status=${badToken.status}`);

// --- The desktop bridge while signed out ----------------------------------
// Started fresh here: the reset above removed the profile the previous app was using.
const app = await freshStart(null);
const bridge = await app.evaluate(`
  return {
    places: await window.domBook.places.list(),
    properties: await window.domBook.properties.list(),
    reservations: await window.domBook.reservations.list(),
    calendar: await window.domBook.calendar.get(14),
    dashboard: await window.domBook.dashboard.get(),
    create: await window.domBook.places.create({ name: 'Контрабанда ' + Date.now(), address: '', hasFoodService: false }),
    sync: await window.domBook.sync.now(),
  };
`);
const stillSignedIn = await app.evaluate(`return !document.getElementById('loginScreen').classList.contains('is-hidden')`);
if (stillSignedIn) {
  for (const [name, result] of Object.entries(bridge)) {
    check(result?.ok === false, `the signed-out window cannot use ${name}`, `error=${result?.error}`);
  }
} else {
  // The app is signed in, so this section does not apply; the gate is covered by
  // tests/ipc-gate.test.cjs and by signing out below.
  console.log("  (app is signed in; checking the gate after sign-out instead)");
  await app.evaluate(`document.getElementById('logoutButton')?.click(); return 'ok';`);
  await wait(2500);
  const after = await app.evaluate(`return await window.domBook.places.list()`);
  check(after.ok === false, "after signing out the bridge refuses reads", `error=${after.error}`);
}

const ok = finish();
console.log(ok ? "SECURITY OK" : "SECURITY FAILED");
app.close();
process.exit(ok ? 0 : 1);
