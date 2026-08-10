// Authentication middleware. Every protected route goes through requireAuth,
// which validates the JWT session token, confirms the session is not revoked,
// and loads the user so the tenant (account_id) is authoritative and current.

import { constantTimeEqual, verifyJwt } from "./crypto";
import type { Env } from "./env";
import { unauthorized } from "./http";
import { Repository } from "./repository";

export interface AuthContext {
  userId: string;
  accountId: string;
  role: string;
  email: string;
  jti: string;
}

export async function requireAuth(
  request: Request,
  env: Env,
  repo: Repository,
): Promise<AuthContext> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) throw unauthorized("Требуется авторизация");

  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims) throw unauthorized("Сессия истекла, войдите снова");

  const sessionId = String(claims.jti ?? "");
  if (!sessionId) throw unauthorized();
  const session = await repo.getActiveSession(sessionId);
  if (!session) throw unauthorized("Сессия недействительна");

  const user = await repo.getUserById(String(claims.sub ?? ""));
  if (!user || user.account_id !== session.account_id) throw unauthorized();

  return { userId: user.id, accountId: user.account_id, role: user.role, email: user.email, jti: sessionId };
}

// Admin endpoints are authenticated separately from customer auth via a
// static admin API key (ADMIN_API_KEY secret). Bypasses the tenant model.
export async function requireAdmin(request: Request, env: Env): Promise<void> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token || !env.ADMIN_API_KEY) throw unauthorized("Требуется admin-ключ");
  if (!(await constantTimeEqual(token, env.ADMIN_API_KEY))) {
    throw unauthorized("Неверный admin-ключ");
  }
}
