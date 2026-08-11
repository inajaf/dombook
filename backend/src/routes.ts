// Route handlers. Kept as pure HTTP handlers over the Repository + AuthService;
// every data route derives the tenant from the authenticated identity.

import { ApiError, badRequest, json, notFound, readJson } from "./http";
import { randomToken, sha256Hex } from "./crypto";
import { nowIso, todayInTimeZone } from "./time";
import { AuthService } from "./auth";
import { Router, type RouteContext } from "./router";
import type { Repository } from "./repository";
import {
  canonicalNameOf,
  validatePlace,
  validateProperty,
  validateReservation,
} from "./validation";
import { SYNC_TABLES, type SyncTable } from "./types";
import { assertCanCreatePlace, assertCanCreateProperty, isKnownPlan } from "./plans";

function ctx(c: RouteContext) {
  return c.auth!;
}

function ensureRole(auth: { role: string }, allowed: string[]): void {
  if (!allowed.includes(auth.role)) {
    throw new ApiError(403, "forbidden", "Недостаточно прав");
  }
}

function publicUser(user: { id: string; email: string; name: string; role: string }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function publicInvite(invite: {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  created_at: string;
}) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at,
  };
}

export function buildRouter(repo: Repository, auth: AuthService): Router {
  const router = new Router(repo);

  // -- auth ----------------------------------------------------------------

  router.post("/auth/setup", async (c) => {
    const result = await auth.setup(await readJson(c.request));
    return json({ ok: true, accountId: result.accountId, user: publicUser(result.user) }, 201);
  });

  router.post("/auth/send", async (c) => {
    const result = await auth.sendCode(await readJson(c.request));
    return json({ ok: true, loginable: result.loginable, code: result.code });
  });

  router.post("/auth/verify", async (c) => {
    const result = await auth.verify(await readJson(c.request));
    return json({
      token: result.token,
      user: publicUser(result.user),
      accountId: result.accountId,
      accountName: result.accountName,
      plan: result.plan,
      inviteAccepted: result.inviteAccepted,
    });
  });

  router.get("/auth/me", async (c) => {
    const session = await repo.userWithAccount(ctx(c).userId);
    if (!session) throw unauthorized_session();
    return json({
      user: publicUser(session.user),
      accountId: session.account.id,
      accountName: session.account.name,
      plan: session.account.plan,
    });
  }, "user");

  router.post("/auth/logout", async (c) => {
    await auth.logout(ctx(c).jti);
    return json({ ok: true });
  }, "user");

  // Manual plan change (owner-only). Billing automation lands later; for now a
  // plan switch is applied directly. Returns the fresh account so the client
  // can re-sync /auth/me state.
  router.patch("/account/plan", async (c) => {
    const me = ctx(c);
    ensureRole(me, ["owner"]);
    const body = await readJson(c.request);
    const plan = String(body.plan ?? "").trim();
    if (!isKnownPlan(plan)) throw badRequest("validation_error", "Некорректный тариф плана");
    const updated = await repo.updateAccountPlan(me.accountId, plan);
    if (!updated) throw unauthorized_session();
    return json({ plan: updated.plan });
  }, "user");

  router.get("/auth/invites", async (c) => {
    const me = ctx(c);
    ensureRole(me, ["owner", "admin"]);
    const invites = await repo.listInvites(me.accountId);
    return json({ invites: invites.map(publicInvite) });
  }, "user");

  router.post("/auth/invites", async (c) => {
    const me = ctx(c);
    ensureRole(me, ["owner", "admin"]);
    const body = await readJson(c.request);
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("validation_error", "Некорректный email");
    const role = body.role === "admin" ? "admin" : "staff";
    const existing = await repo.findPendingInvite(me.accountId, email);
    if (existing) throw badRequest("invite_exists", "Приглашение для этого email уже отправлено");
    const inviteToken = randomToken(32);
    const tokenHash = await sha256Hex(inviteToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const invite = await repo.createInvite({
      accountId: me.accountId,
      email,
      role,
      tokenHash,
      createdBy: me.userId,
      expiresAt,
    });
    return json({ invite: publicInvite(invite), inviteToken }, 201);
  }, "user");

  router.post("/auth/invites/:id/revoke", async (c) => {
    const me = ctx(c);
    ensureRole(me, ["owner", "admin"]);
    const invite = await repo.revokeInvite(me.accountId, c.params.id!);
    if (!invite) throw notFound("invite_not_found", "Приглашение не найдено");
    return json({ ok: true, invite: publicInvite(invite) });
  }, "user");

  // -- places --------------------------------------------------------------

  router.get("/places", async (c) => {
    const includeArchived = c.url.searchParams.get("includeArchived") !== "false";
    return json({ places: await repo.listPlaces(ctx(c).accountId, includeArchived) });
  }, "user");

  router.post("/places", async (c) => {
    const me = ctx(c);
    const current = await repo.countActivePlaces(me.accountId);
    const account = await repo.getAccount(me.accountId);
    assertCanCreatePlace(current, account?.plan ?? "free");
    const data = validatePlace(await readJson(c.request));
    assertUniqueName(
      await repo.listPlaces(me.accountId),
      data.name,
      null,
      "Дом отдыха с таким названием уже существует",
    );
    const place = await repo.createPlace(me.accountId, data, device(c));
    return json({ place }, 201);
  }, "user");

  router.get("/places/:id", async (c) => {
    const place = await repo.getPlace(ctx(c).accountId, c.params.id!);
    if (!place) throw notFound();
    return json({ place });
  }, "user");

  router.put("/places/:id", async (c) => {
    const me = ctx(c);
    const data = validatePlace(await readJson(c.request));
    assertUniqueName(
      await repo.listPlaces(me.accountId),
      data.name,
      c.params.id!,
      "Дом отдыха с таким названием уже существует",
    );
    const place = await repo.updatePlace(me.accountId, c.params.id!, data, device(c));
    if (!place) throw notFound();
    return json({ place });
  }, "user");

  router.post("/places/:id/archive", async (c) => {
    const place = await repo.setPlaceStatus(ctx(c).accountId, c.params.id!, "archived", device(c));
    if (!place) throw notFound();
    return json({ place });
  }, "user");

  router.post("/places/:id/restore", async (c) => {
    const place = await repo.setPlaceStatus(ctx(c).accountId, c.params.id!, "active", device(c));
    if (!place) throw notFound();
    return json({ place });
  }, "user");

  router.delete("/places/:id", async (c) => {
    const removed = await repo.softDeletePlace(ctx(c).accountId, c.params.id!, device(c));
    if (!removed) throw notFound();
    return json({ ok: true });
  }, "user");

  // -- properties ----------------------------------------------------------

  router.get("/properties", async (c) => {
    const includeArchived = c.url.searchParams.get("includeArchived") !== "false";
    return json({ properties: await repo.listProperties(ctx(c).accountId, includeArchived) });
  }, "user");

  router.post("/properties", async (c) => {
    const me = ctx(c);
    const currentProperties = await repo.countActiveProperties(me.accountId);
    const account = await repo.getAccount(me.accountId);
    assertCanCreateProperty(currentProperties, account?.plan ?? "free");
    const body = await readJson(c.request);
    const data = await validateProperty(body, (id) => repo.getPlace(me.accountId, id));
    assertUniqueName(
      await repo.listProperties(me.accountId),
      data.name,
      null,
      "Объект с таким наименованием уже существует",
    );
    const property = await repo.createProperty(me.accountId, data, device(c));
    return json({ property }, 201);
  }, "user");

  router.get("/properties/:id", async (c) => {
    const property = await repo.getProperty(ctx(c).accountId, c.params.id!);
    if (!property) throw notFound();
    return json({ property });
  }, "user");

  router.put("/properties/:id", async (c) => {
    const me = ctx(c);
    const body = await readJson(c.request);
    const data = await validateProperty(body, (id) => repo.getPlace(me.accountId, id));
    assertUniqueName(
      await repo.listProperties(me.accountId),
      data.name,
      c.params.id!,
      "Объект с таким наименованием уже существует",
    );
    const property = await repo.updateProperty(me.accountId, c.params.id!, data, device(c));
    if (!property) throw notFound();
    return json({ property });
  }, "user");

  router.post("/properties/:id/archive", async (c) => {
    const property = await repo.setPropertyStatus(ctx(c).accountId, c.params.id!, "archived", device(c));
    if (!property) throw notFound();
    return json({ property });
  }, "user");

  router.post("/properties/:id/restore", async (c) => {
    const property = await repo.setPropertyStatus(ctx(c).accountId, c.params.id!, "active", device(c));
    if (!property) throw notFound();
    return json({ property });
  }, "user");

  router.delete("/properties/:id", async (c) => {
    const removed = await repo.softDeleteProperty(ctx(c).accountId, c.params.id!, device(c));
    if (!removed) throw notFound();
    return json({ ok: true });
  }, "user");

  // -- reservations --------------------------------------------------------

  router.get("/reservations", async (c) => {
    return json({ reservations: await repo.listReservations(ctx(c).accountId) });
  }, "user");

  router.post("/reservations", async (c) => {
    const me = ctx(c);
    const data = await validateReservation(
      await readJson(c.request),
      reservationDeps(repo, me.accountId),
    );
    const reservation = await repo.createReservation(me.accountId, data, device(c));
    return json({ reservation }, 201);
  }, "user");

  router.get("/reservations/:id", async (c) => {
    const reservation = await repo.getReservation(ctx(c).accountId, c.params.id!);
    if (!reservation) throw notFound();
    return json({ reservation });
  }, "user");

  router.put("/reservations/:id", async (c) => {
    const me = ctx(c);
    const body = await readJson(c.request);
    const existing = await repo.getReservation(me.accountId, c.params.id!);
    if (!existing) throw notFound();
    const data = await validateReservation(body, reservationDeps(repo, me.accountId), existing.id);
    const reservation = await repo.updateReservation(me.accountId, existing.id, data, device(c));
    return json({ reservation });
  }, "user");

  router.post("/reservations/:id/cancel", async (c) => {
    const me = ctx(c);
    const reservation = await repo.getReservation(me.accountId, c.params.id!);
    if (!reservation) throw notFound();
    if (["cancelled", "no_show", "checked_out"].includes(reservation.status)) {
      return json({ reservation });
    }
    const updated = await repo.setReservationStatus(
      me.accountId, reservation.id, "cancelled", "cancelled", device(c),
    );
    return json({ reservation: updated });
  }, "user");

  router.delete("/reservations/:id", async (c) => {
    const me = ctx(c);
    const reservation = await repo.getReservation(me.accountId, c.params.id!);
    if (!reservation) throw notFound();
    if (!["cancelled", "no_show", "checked_out"].includes(reservation.status)) {
      throw badRequest(
        "reservation_active",
        "Сначала отмените активную бронь, затем удалите её из истории",
      );
    }
    await repo.softDeleteReservation(me.accountId, reservation.id, device(c));
    return json({ ok: true });
  }, "user");

  // -- app settings --------------------------------------------------------

  router.get("/settings", async (c) => {
    return json({ settings: await repo.listAppSettings(ctx(c).accountId) });
  }, "user");

  router.put("/settings/:key", async (c) => {
    const me = ctx(c);
    const key = String(c.params.key ?? "").trim();
    if (!key || key.length > 64) throw badRequest("validation_error", "Некорректный ключ настройки");
    const body = await readJson(c.request);
    const value = String(body.value ?? "").trim();
    if (!value || value.length > 2000) throw badRequest("validation_error", "Некорректное значение настройки");
    const setting = await repo.setAppSetting(me.accountId, key, value, device(c));
    return json({ setting });
  }, "user");

  // -- sync ----------------------------------------------------------------

  router.get("/sync/pull", async (c) => {
    const me = ctx(c);
    const rawSince = Number(c.url.searchParams.get("since") ?? "0");
    const since = Number.isInteger(rawSince) && rawSince >= 0 ? rawSince : 0;
    const state = await repo.getTenantState(me.accountId);
    const version = state?.version ?? 0;
    const changes = await repo.pullChanges(me.accountId, since);
    return json({
      state: { version, updatedAt: state?.updated_at ?? null },
      changes,
    });
  }, "user");

  router.post("/sync/push", async (c) => {
    const me = ctx(c);
    const body = await readJson(c.request);
    const clientId = String(body.clientId ?? "unknown").slice(0, 64) || "unknown";
    const changes = body.changes as Record<string, unknown[]>;
    if (!changes || typeof changes !== "object") {
      throw badRequest("validation_error", "Неверный формат изменений");
    }
    let applied = 0;
    for (const table of Object.keys(changes)) {
      if (!(SYNC_TABLES as readonly string[]).includes(table)) {
        throw badRequest("validation_error", `Неизвестная таблица: ${table}`);
      }
      const rows = changes[table];
      if (!Array.isArray(rows)) throw badRequest("validation_error", `Неверный формат для ${table}`);
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const pushed = await repo.pushRow(table as SyncTable, me.accountId, {
          ...(row as Record<string, unknown>),
          last_writer: clientId,
        });
        if (pushed) applied += 1;
      }
    }
    const state = await repo.getTenantState(me.accountId);
    return json({
      state: { version: state?.version ?? 0, updatedAt: state?.updated_at ?? null },
      applied,
    });
  }, "user");

  // -- backups -------------------------------------------------------------

  router.get("/backups/export", async (c) => {
    const me = ctx(c);
    const state = await repo.getTenantState(me.accountId);
    const data: Record<string, unknown[]> = {};
    for (const table of SYNC_TABLES) {
      data[table] = await repo.pullChanges(me.accountId, -1).then((all) => all[table]);
    }
    return json({
      exportedAt: nowIso(),
      schemaVersion: "0001",
      accountId: me.accountId,
      state: { version: state?.version ?? 0, updatedAt: state?.updated_at ?? null },
      data,
    });
  }, "user");

  return router;
}

function reservationDeps(repo: Repository, accountId: string) {
  return {
    getProperty: (id: string) => repo.getProperty(accountId, id),
    getPlace: (id: string) => repo.getPlace(accountId, id),
    getReservation: (id: string) => repo.getReservation(accountId, id),
    todayProvider: () => todayInTimeZone(),
  };
}

function assertUniqueName(
  rows: { id: string; name: string }[],
  name: string,
  excludeId: string | null,
  message: string,
): void {
  const normalized = canonicalNameOf(name);
  const duplicate = rows.find(
    (row) => row.id !== excludeId && canonicalNameOf(row.name) === normalized,
  );
  if (duplicate) throw badRequest("validation_error", message);
}

function device(c: RouteContext): string {
  return String(c.request.headers.get("x-client-id") ?? "api").slice(0, 64) || "api";
}

function unauthorized_session(): ApiError {
  return new ApiError(401, "unauthorized", "Сессия не найдена");
}
