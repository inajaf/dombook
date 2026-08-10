// Workers-Auth-compatible authentication service: email + one-time-code
// (OTP) magic-link login, JWT session tokens with server-side revocation.
//
// The upstream `@cloudflare/workers-auth-provider` package was not published
// on npm at the time of writing, so this module implements the same contract
// (users / verification_codes / sessions tables, authorize → verify → session)
// in-repo. Swapping in the upstream provider later does not change the HTTP
// contract or the D1 schema; see docs/saas-spec.md.

import { ApiError, badRequest, forbidden, unauthorized } from "./http";
import { constantTimeEqual, otpCode, sha256Hex, signJwt, uuid } from "./crypto";
import { nowIso } from "./time";
import type { Env } from "./env";
import { Repository } from "./repository";
import type { User } from "./types";

export interface SessionClaims {
  sub: string;
  act: string;
  role: string;
  email: string;
  jti: string;
}

export class AuthService {
  constructor(
    private env: Env,
    private repo: Repository,
  ) {}

  otpTtlSeconds(): number {
    return Number(this.env.AUTH_OTP_TTL_SECONDS) || 600;
  }

  sessionTtlSeconds(): number {
    return Number(this.env.AUTH_SESSION_TTL_SECONDS) || 30 * 24 * 60 * 60;
  }

  exposeCode(): boolean {
    const value = this.env.AUTH_EXPOSE_CODE;
    return value === "true" || value === "1";
  }

  private normalizeEmail(value: unknown): string {
    const email = String(value ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw badRequest("validation_error", "Некорректный email");
    }
    return email;
  }

  // Bootstrap: create the owner account + user. Open only while no users
  // exist; afterwards requires the SETUP_TOKEN secret.
  async setup(input: Record<string, unknown>): Promise<{ accountId: string; user: User }> {
    const existingUsers = await this.repo.countUsers();
    if (existingUsers > 0) {
      const token = String(input.setupToken ?? "");
      if (!this.env.SETUP_TOKEN || !token || !(await constantTimeEqual(token, this.env.SETUP_TOKEN))) {
        throw forbidden("setup_denied", "Регистрация закрыта: требуется токен настройки");
      }
    }
    const email = this.normalizeEmail(input.email);
    if (await this.repo.getUserByEmail(email)) {
      throw badRequest("user_exists", "Пользователь с таким email уже существует");
    }
    const name = String(input.name ?? "").trim();
    const accountName = String(input.accountName ?? name ?? "").trim() || "Дом отдыха";
    const account = await this.repo.createAccount(accountName, "free");
    const user = await this.repo.createUser({
      id: uuid(),
      accountId: account.id,
      email,
      name,
      role: "owner",
    });
    return { accountId: account.id, user };
  }

  // Issue a one-time code for the email if a user or pending invite exists.
  // Returns the code only when AUTH_EXPOSE_CODE is enabled (dev/tests).
  async sendCode(
    input: Record<string, unknown>,
  ): Promise<{ ok: true; loginable: boolean; code?: string }> {
    const email = this.normalizeEmail(input.email);
    const user = await this.repo.getUserByEmail(email);
    const invite = user ? null : await this.repo.findInviteByEmail(email);
    if (!user && !invite) return { ok: true, loginable: false };

    const code = otpCode();
    const codeHash = await sha256Hex(code);
    const expiresAt = new Date(Date.now() + this.otpTtlSeconds() * 1000).toISOString();
    await this.repo.createVerificationCode({ id: uuid(), email, codeHash, expiresAt });
    await this.deliverCode(email, code, expiresAt);
    return { ok: true, loginable: true, ...(this.exposeCode() ? { code } : {}) };
  }

  async verify(
    input: Record<string, unknown>,
  ): Promise<{ token: string; user: User; accountId: string; accountName: string; plan: string; inviteAccepted: boolean }> {
    const email = this.normalizeEmail(input.email);
    const code = String(input.code ?? "").trim();
    if (!code) throw badRequest("validation_error", "Укажите код из письма");
    const codeHash = await sha256Hex(code);
    const claimed = await this.repo.consumeVerificationCode(email, codeHash);
    if (!claimed) throw unauthorized("Неверный или истёкший код");

    let user = await this.repo.getUserByEmail(email);
    let inviteAccepted = false;
    if (!user) {
      const invite = await this.repo.findInviteByEmail(email);
      if (!invite) throw forbidden("no_account", "Для этого email не создана учётная запись");
      user = await this.repo.createUser({
        id: uuid(),
        accountId: invite.account_id,
        email,
        name: email.split("@")[0] ?? email,
        role: invite.role,
      });
      await this.repo.markInviteAccepted(invite.account_id, invite.id);
      inviteAccepted = true;
    }

    const token = await this.createSessionToken(user);
    const account = await this.repo.getAccount(user.account_id);
    return {
      token,
      user,
      accountId: user.account_id,
      accountName: account?.name ?? "",
      plan: account?.plan ?? "free",
      inviteAccepted,
    };
  }

  async createSessionToken(user: User): Promise<string> {
    const jti = uuid();
    const ttl = this.sessionTtlSeconds();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await this.repo.createSession({ id: jti, userId: user.id, accountId: user.account_id, expiresAt });
    return signJwt(
      { sub: user.id, act: user.account_id, role: user.role, email: user.email, jti },
      this.env.JWT_SECRET,
      ttl,
    );
  }

  async logout(jti: string): Promise<void> {
    await this.repo.revokeSession(jti);
  }

  private async deliverCode(email: string, code: string, expiresAt: string): Promise<void> {
    const app = this.env.APP_NAME || "ДомБук";
    const subject = `${app}: код входа`;
    const text = `Ваш код входа в ${app}: ${code}. Действует до ${expiresAt}.`;
    // Transport seam: replace with a real email sender (Cloudflare Email
    // Sending / SMTP / Resend) in production. See docs/saas-spec.md.
    console.log(`[auth-email] to=${email} subject=${subject}\n${text}`);
  }
}
