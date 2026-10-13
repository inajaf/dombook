// Verifies the team-invitation flow end to end against a running server.
//
//   AUTH_EXPOSE_CODE=true go run ./cmd/api   # then:
//   node scripts/verify-invites.mjs
//
// Covers the whole path a real colleague takes: invite, become loginable, sign in, join the
// account, share its data, and be refused administrative actions. Also covers revocation
// closing the door again. The send throttle is respected rather than disabled.
const BASE = process.env.DOMBOOK_VERIFY_URL || "http://127.0.0.1:8787";
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
/**
 * Request a login code, waiting out the send throttle if it fires.
 *
 * The limiter is deliberate — one code per address per minute — so a script that hammers
 * /auth/send is testing nothing but its own impatience. A response carrying rate_limited is
 * retried once the window it reports has passed.
 */
async function sendCode(email) {
  let response = await call("POST", "/auth/send", { body: { email } });
  if (response.body?.error?.code === "rate_limited") {
    const seconds = Number((response.body.error.message.match(/(\d+)\s*с/) ?? [])[1] ?? 60);
    process.stdout.write(`   (waiting ${seconds}s for the send throttle)\n`);
    await new Promise((resolve) => setTimeout(resolve, (seconds + 2) * 1000));
    response = await call("POST", "/auth/send", { body: { email } });
  }
  return response;
}

async function signIn(email, code) {
  const send = code === undefined ? await sendCode(email) : null;
  const sent = code ?? send.body.code;
  return call("POST", "/auth/verify", { body: { email, code: sent } });
}

const ownerEmail = "owner@example.test";
await call("POST", "/auth/setup", { body: { email: ownerEmail, accountName: "Лесная долина" } });
const owner = await signIn(ownerEmail);
const ownerToken = owner.body.token;
check("owner signed in", Boolean(ownerToken));

const colleague = "colleague@example.test";

// Before the invitation, the address does not exist — and /auth/send must not say so.
const before = await sendCode(colleague);
check("an unknown address reports not-loginable", before.body.loginable === false, `loginable=${before.body.loginable}`);

const invited = await call("POST", "/auth/invites", { token: ownerToken, body: { email: colleague, role: "staff" } });
check("owner invited a colleague", invited.status === 201, `status=${invited.status}`);
check("the token is returned once", typeof invited.body.inviteToken === "string" && invited.body.inviteToken.length >= 32);

const listed = await call("GET", "/auth/invites", { token: ownerToken });
check("the invitation is listed", listed.body.invites?.length === 1, `count=${listed.body.invites?.length}`);
check("the listing does not leak the token", !JSON.stringify(listed.body).includes(invited.body.inviteToken));

// After inviting, the same address becomes loginable. This is the whole point of the route:
// without it the colleague could never sign in.
const after = await sendCode(colleague);
check("an invited address becomes loginable", after.body.loginable === true, `loginable=${after.body.loginable}`);

const joined = await signIn(colleague, after.body.code);
check("the invited colleague signs in", Boolean(joined.body.token), `status=${joined.status}`);
check("they joined the owner's account", joined.body.accountName === "Лесная долина", `account=${joined.body.accountName}`);
check("they get the invited role", joined.body.user?.role === "staff", `role=${joined.body.user?.role}`);

// A staff member shares the account's data.
const places = await call("POST", "/places", { token: ownerToken, body: { name: "База", address: "", hasFoodService: false } });
check("owner created a place", places.status === 201, `status=${places.status}`);
const colleagueSees = await call("GET", "/places", { token: joined.body.token });
check("the colleague sees the account's data", colleagueSees.body.places?.length === 1, `places=${colleagueSees.body.places?.length}`);

// But cannot invite: that is an administrative act.
const staffInvite = await call("POST", "/auth/invites", { token: joined.body.token, body: { email: "another@example.test" } });
check("a staff member cannot invite", staffInvite.status === 403, `status=${staffInvite.status}`);
const staffList = await call("GET", "/auth/invites", { token: joined.body.token });
check("a staff member cannot list invitations", staffList.status === 403, `status=${staffList.status}`);

// An ACCEPTED invitation is no longer pending, so revoking it must report that there is
// nothing to revoke — the colleague already has the access.
const acceptedId = listed.body.invites[0].id;
const revokeAccepted = await call("POST", `/auth/invites/${acceptedId}/revoke`, { token: ownerToken });
check("an accepted invitation cannot be revoked", revokeAccepted.status === 404, `status=${revokeAccepted.status}`);

// A pending invitation that nobody has accepted IS revocable, and revoking it closes the
// door: the address stops being loginable.
const doomed = await call("POST", "/auth/invites", { token: ownerToken, body: { email: "doomed@example.test" } });
check("owner invited a second person", doomed.status === 201, `status=${doomed.status}`);
const doomedId = doomed.body.invite.id;

const revoked = await call("POST", `/auth/invites/${doomedId}/revoke`, { token: ownerToken });
check("owner revoked a pending invitation", revoked.status === 200, `status=${revoked.status}`);
const secondRevoke = await call("POST", `/auth/invites/${doomedId}/revoke`, { token: ownerToken });
check("revoking twice reports nothing to revoke", secondRevoke.status === 404, `status=${secondRevoke.status}`);

const afterRevoke = await sendCode("doomed@example.test");
check("a revoked address is no longer loginable", afterRevoke.body.loginable === false, `loginable=${afterRevoke.body.loginable}`);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
