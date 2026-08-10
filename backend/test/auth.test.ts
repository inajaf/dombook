import { describe, expect, it } from "vitest";
import { api, json, createAccount } from "./helpers";

describe("auth", () => {
  it("bootstraps an owner account via setup", async () => {
    const email = "owner@example.test";
    const response = await api("POST", "/auth/setup", {
      body: { email, name: "Владелец", accountName: "Дом у озера" },
    });
    expect(response.status).toBe(201);
    const body = await json<{ accountId: string; user: { id: string; email: string; role: string } }>(response);
    expect(body.user.email).toBe(email);
    expect(body.user.role).toBe("owner");
    expect(body.accountId).toBeTruthy();
  });

  it("rejects a second setup without a setup token once users exist", async () => {
    await createAccount("first@example.test");
    const response = await api("POST", "/auth/setup", {
      body: { email: "second@example.test", name: "Второй", accountName: "Другой дом" },
    });
    expect(response.status).toBe(403);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("setup_denied");
  });

  it("issues a code for a known email and verifies it into a session", async () => {
    const email = "login@example.test";
    await createAccount(email, "Дом для логина");

    const sent = await api("POST", "/auth/send", { body: { email } });
    expect(sent.status).toBe(200);
    const sentBody = await json<{ loginable: boolean; code: string }>(sent);
    expect(sentBody.loginable).toBe(true);

    const verified = await api("POST", "/auth/verify", { body: { email, code: sentBody.code } });
    expect(verified.status).toBe(200);
    const verifiedBody = await json<{ token: string; user: { email: string } }>(verified);
    expect(verifiedBody.user.email).toBe(email);
    expect(verifiedBody.token).toBeTruthy();
  });

  it("does not reveal loginability for unknown emails", async () => {
    const sent = await api("POST", "/auth/send", { body: { email: "nobody@example.test" } });
    const body = await json<{ loginable: boolean }>(sent);
    expect(body.loginable).toBe(false);
  });

  it("rejects an invalid code", async () => {
    const email = "wrong-code@example.test";
    await createAccount(email);
    const response = await api("POST", "/auth/verify", { body: { email, code: "000000" } });
    expect(response.status).toBe(401);
  });

  it("serves /auth/me for an authenticated session", async () => {
    const { token, accountId } = await createAccount("me@example.test", "Мой дом");
    const response = await api("GET", "/auth/me", { token });
    expect(response.status).toBe(200);
    const body = await json<{ accountId: string; accountName: string; plan: string }>(response);
    expect(body.accountId).toBe(accountId);
    expect(body.accountName).toBe("Мой дом");
    expect(body.plan).toBe("free");
  });

  it("rejects /auth/me without a token", async () => {
    const response = await api("GET", "/auth/me");
    expect(response.status).toBe(401);
  });

  it("revokes the session on logout", async () => {
    const { token } = await createAccount("logout@example.test");
    const loggedOut = await api("POST", "/auth/logout", { token });
    expect(loggedOut.status).toBe(200);
    const response = await api("GET", "/auth/me", { token });
    expect(response.status).toBe(401);
  });

  it("lets an owner invite a staff member who can then log in", async () => {
    const { token } = await createAccount("boss@example.test", "Хозяйство");

    const created = await api("POST", "/auth/invites", {
      token,
      body: { email: "staff@example.test", role: "staff" },
    });
    expect(created.status).toBe(201);
    const createdBody = await json<{ invite: { email: string; role: string }; inviteToken: string }>(created);
    expect(createdBody.invite.role).toBe("staff");
    expect(createdBody.inviteToken).toBeTruthy();

    const listed = await api("GET", "/auth/invites", { token });
    expect(listed.status).toBe(200);
    const listedBody = await json<{ invites: { email: string; status: string }[] }>(listed);
    expect(listedBody.invites).toHaveLength(1);

    const sent = await api("POST", "/auth/send", { body: { email: "staff@example.test" } });
    const sentBody = await json<{ loginable: boolean; code: string }>(sent);
    expect(sentBody.loginable).toBe(true);

    const verified = await api("POST", "/auth/verify", { body: { email: "staff@example.test", code: sentBody.code } });
    expect(verified.status).toBe(200);
    const verifiedBody = await json<{ inviteAccepted: boolean; user: { role: string } }>(verified);
    expect(verifiedBody.inviteAccepted).toBe(true);
    expect(verifiedBody.user.role).toBe("staff");
  });

  it("forbids staff from creating invites", async () => {
    const { token } = await createAccount("boss2@example.test", "Хозяйство 2");
    await api("POST", "/auth/invites", { token, body: { email: "staff2@example.test", role: "staff" } });
    const sent = await api("POST", "/auth/send", { body: { email: "staff2@example.test" } });
    const sentBody = await json<{ code: string }>(sent);
    const staff = await api("POST", "/auth/verify", { body: { email: "staff2@example.test", code: sentBody.code } });
    const staffBody = await json<{ token: string }>(staff);

    const response = await api("POST", "/auth/invites", {
      token: staffBody.token,
      body: { email: "another@example.test", role: "staff" },
    });
    expect(response.status).toBe(403);
  });

  it("lets an owner revoke a pending invite", async () => {
    const { token } = await createAccount("boss3@example.test", "Хозяйство 3");
    const created = await api("POST", "/auth/invites", {
      token,
      body: { email: "revoke-me@example.test", role: "staff" },
    });
    const createdBody = await json<{ invite: { id: string; status: string } }>(created);

    const revoked = await api("POST", `/auth/invites/${createdBody.invite.id}/revoke`, { token });
    expect(revoked.status).toBe(200);
    const revokedBody = await json<{ invite: { status: string } }>(revoked);
    expect(revokedBody.invite.status).toBe("revoked");
  });
});
