// Repository layer over the D1 binding. Every data query is scoped to a
// tenant_id passed by the caller (derived from the authenticated identity).
// The worker routes only ever call these methods with the authenticated
// tenant, which is what makes cross-tenant access impossible by construction.
//
// This layer is the seam for the VPS portability path: it speaks plain
// SQLite SQL, so re-hosting on a VPS means pointing this class at a SQLite
// driver instead of D1 without changing the domain logic above it.

import { nowIso } from "./time";
import { firstRow, allRows } from "./db";
import type { D1Result } from "@cloudflare/workers-types";
import { ApiError } from "./http";
import type {
  Account,
  AppSetting,
  Invite,
  Place,
  Property,
  Reservation,
  ReservationMeal,
  Session,
  SyncRow,
  SyncTable,
  TenantState,
  User,
} from "./types";
import { SYNC_TABLES } from "./types";

const SYNC_COLUMNS: Record<SyncTable, string[]> = {
  places: [
    "id", "tenant_id", "name", "address", "has_food_service",
    "breakfast_price_minor", "lunch_price_minor", "dinner_price_minor",
    "status", "notes", "created_at", "updated_at", "deleted_at",
    "version", "last_writer",
  ],
  properties: [
    "id", "tenant_id", "place_id", "kind", "name", "location", "capacity",
    "base_price_minor", "deposit_minor", "currency", "check_in_time",
    "check_out_time", "status", "notes", "created_at", "updated_at",
    "deleted_at", "version", "last_writer",
  ],
  reservations: [
    "id", "tenant_id", "property_id", "guest_name", "guest_phone", "guest_email",
    "check_in_date", "check_out_date", "adults", "children", "status",
    "nightly_rate_minor", "accommodation_minor", "services_minor", "total_minor",
    "prepaid_minor", "deposit_minor", "deposit_status", "actual_check_out_date",
    "notes", "created_at", "updated_at", "deleted_at", "version", "last_writer",
  ],
  reservation_nights: [
    "id", "tenant_id", "reservation_id", "property_id", "night_date",
    "created_at", "updated_at", "deleted_at", "version", "last_writer",
  ],
  reservation_services: [
    "id", "tenant_id", "reservation_id", "service_type", "service_name",
    "unit_price_minor", "quantity", "created_at", "updated_at", "deleted_at",
    "version", "last_writer",
  ],
  reservation_meals: [
    "id", "tenant_id", "reservation_id", "meal_date", "meal_type", "amount_minor",
    "created_at", "updated_at", "deleted_at", "version", "last_writer",
  ],
  app_settings: [
    "id", "tenant_id", "setting_key", "setting_value", "created_at",
    "updated_at", "deleted_at", "version", "last_writer",
  ],
};

function canonicalJson(row: SyncRow): string {
  const copy: SyncRow = { ...row };
  delete copy.version;
  const sorted: SyncRow = {};
  for (const key of Object.keys(copy).sort()) sorted[key] = copy[key];
  return JSON.stringify(sorted);
}

// Last-write-wins comparison: updated_at, then last_writer (client id),
// then canonical row JSON. Deterministic across replicas.
function rowCompare(a: SyncRow, b: SyncRow): number {
  const au = String(a.updated_at ?? "");
  const bu = String(b.updated_at ?? "");
  if (au !== bu) return au < bu ? -1 : 1;
  const aw = String(a.last_writer ?? "");
  const bw = String(b.last_writer ?? "");
  if (aw !== bw) return aw < bw ? -1 : 1;
  const ja = canonicalJson(a);
  const jb = canonicalJson(b);
  return ja === jb ? 0 : ja < jb ? -1 : 1;
}

export class Repository {
  constructor(private db: D1Database) {}

  private prep(sql: string, params: unknown[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(...params);
  }

  // -- auth / tenancy -------------------------------------------------------

  async createAccount(name: string, plan: string): Promise<Account> {
    const id = crypto.randomUUID();
    const now = nowIso();
    await this.db
      .batch([
        this.prep(
          "INSERT INTO accounts(id, name, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          [id, name, plan, now, now],
        ),
        this.prep(
          "INSERT INTO tenant_state(tenant_id, version, updated_at) VALUES (?, 0, ?)",
          [id, now],
        ),
      ]);
    const account = await this.getAccount(id);
    return account!;
  }

  async getAccount(id: string): Promise<Account | null> {
    return firstRow<Account>(
      await this.prep("SELECT * FROM accounts WHERE id = ?", [id]).first(),
    ) ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return firstRow<User>(
      await this.prep("SELECT * FROM users WHERE email = ? COLLATE NOCASE", [email]).first(),
    ) ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    return firstRow<User>(
      await this.prep("SELECT * FROM users WHERE id = ?", [id]).first(),
    ) ?? null;
  }

  async createUser(input: {
    id: string;
    accountId: string;
    email: string;
    name: string;
    role: User["role"];
  }): Promise<User> {
    const now = nowIso();
    await this.prep(
      `INSERT INTO users(id, account_id, email, name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.accountId, input.email.toLowerCase(), input.name, input.role, now, now],
    ).run();
    return (await this.getUserById(input.id))!;
  }

  async countUsers(): Promise<number> {
    const result = await this.db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    return Number(result?.n ?? 0);
  }

  async userWithAccount(userId: string): Promise<{ user: User; account: Account } | null> {
    const row = await this.db
      .prepare(
        `SELECT u.id AS user_id, u.account_id, u.email, u.name AS user_name, u.role,
                a.name AS account_name, a.plan
         FROM users u JOIN accounts a ON a.id = u.account_id
         WHERE u.id = ?`,
      )
      .bind(userId)
      .first<{
        user_id: string;
        account_id: string;
        email: string;
        user_name: string;
        role: User["role"];
        account_name: string;
        plan: string;
      }>();
    if (!row) return null;
    return {
      user: {
        id: row.user_id,
        account_id: row.account_id,
        email: row.email,
        name: row.user_name,
        role: row.role,
        created_at: "",
        updated_at: "",
      },
      account: {
        id: row.account_id,
        name: row.account_name,
        plan: row.plan as Account["plan"],
        created_at: "",
        updated_at: "",
      },
    };
  }

  async findPendingInvite(accountId: string, email: string): Promise<Invite | null> {
    return firstRow<Invite>(
      await this.prep(
        `SELECT * FROM invites
         WHERE account_id = ? AND email = ? COLLATE NOCASE
           AND status = 'pending' AND deleted_at IS NULL AND expires_at > ?`,
        [accountId, email, nowIso()],
      ).first(),
    ) ?? null;
  }

  async findInviteByEmail(email: string): Promise<Invite | null> {
    return firstRow<Invite>(
      await this.prep(
        `SELECT * FROM invites
         WHERE email = ? COLLATE NOCASE AND status = 'pending'
           AND deleted_at IS NULL AND expires_at > ?`,
        [email, nowIso()],
      ).first(),
    ) ?? null;
  }

  async findInviteByTokenHash(tokenHash: string): Promise<Invite | null> {
    return firstRow<Invite>(
      await this.prep("SELECT * FROM invites WHERE token_hash = ?", [tokenHash]).first(),
    ) ?? null;
  }

  async getInvite(accountId: string, inviteId: string): Promise<Invite | null> {
    return firstRow<Invite>(
      await this.prep(
        "SELECT * FROM invites WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
        [inviteId, accountId],
      ).first(),
    ) ?? null;
  }

  async createInvite(input: {
    accountId: string;
    email: string;
    role: "admin" | "staff";
    tokenHash: string;
    createdBy: string;
    expiresAt: string;
  }): Promise<Invite> {
    const id = crypto.randomUUID();
    const now = nowIso();
    await this.prep(
      `INSERT INTO invites(id, account_id, email, role, token_hash, created_by, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id, input.accountId, input.email.toLowerCase(), input.role, input.tokenHash,
        input.createdBy, input.expiresAt, now, now,
      ],
    ).run();
    return (await this.getInvite(input.accountId, id))!;
  }

  async listInvites(accountId: string): Promise<Invite[]> {
    return allRows<Invite>(
      await this.prep(
        "SELECT * FROM invites WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
        [accountId],
      ).all(),
    );
  }

  async markInviteAccepted(accountId: string, inviteId: string): Promise<void> {
    const now = nowIso();
    await this.prep(
      "UPDATE invites SET status = 'accepted', updated_at = ? WHERE id = ? AND account_id = ?",
      [now, inviteId, accountId],
    ).run();
  }

  async revokeInvite(accountId: string, inviteId: string): Promise<Invite | null> {
    const existing = await this.getInvite(accountId, inviteId);
    if (!existing) return null;
    const now = nowIso();
    await this.prep(
      "UPDATE invites SET status = 'revoked', deleted_at = ?, updated_at = ? WHERE id = ? AND account_id = ?",
      [now, now, inviteId, accountId],
    ).run();
    const updated = firstRow<Invite>(
      await this.prep("SELECT * FROM invites WHERE id = ? AND account_id = ?", [inviteId, accountId]).first(),
    );
    return updated ?? { ...existing, status: "revoked", deleted_at: now, updated_at: now };
  }

  async createVerificationCode(input: {
    id: string;
    email: string;
    codeHash: string;
    expiresAt: string;
  }): Promise<void> {
    const now = nowIso();
    await this.prep(
      `INSERT INTO verification_codes(id, email, code, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.id, input.email.toLowerCase(), input.codeHash, input.expiresAt, now, now],
    ).run();
  }

  // Atomically claims an unused, unexpired code for the email.
  async consumeVerificationCode(email: string, codeHash: string): Promise<string | null> {
    const result = await this.db
      .prepare(
        `UPDATE verification_codes
         SET used_at = ?
         WHERE email = ? COLLATE NOCASE AND code = ? AND used_at IS NULL AND expires_at > ?
         RETURNING id`,
      )
      .bind(nowIso(), email, codeHash, nowIso())
      .first<{ id: string }>();
    return result?.id ?? null;
  }

  async createSession(input: {
    id: string;
    userId: string;
    accountId: string;
    expiresAt: string;
  }): Promise<void> {
    const now = nowIso();
    await this.prep(
      `INSERT INTO sessions(id, user_id, account_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.id, input.userId, input.accountId, input.expiresAt, now, now],
    ).run();
  }

  async getActiveSession(id: string): Promise<Session | null> {
    return firstRow<Session>(
      await this.prep(
        `SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
        [id, nowIso()],
      ).first(),
    ) ?? null;
  }

  async revokeSession(id: string): Promise<void> {
    const now = nowIso();
    await this.prep(
      "UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE id = ?",
      [now, now, id],
    ).run();
  }

  // -- tenant state / sync watermark ----------------------------------------

  async getTenantState(tenantId: string): Promise<TenantState | null> {
    return firstRow<TenantState>(
      await this.prep("SELECT * FROM tenant_state WHERE tenant_id = ?", [tenantId]).first(),
    ) ?? null;
  }

  // Atomically advances the tenant watermark (RETURNING) — safe under
  // concurrency and immune to clock skew by construction.
  async bumpTenantVersion(tenantId: string): Promise<number> {
    const now = nowIso();
    const row = await this.db
      .prepare(
        `UPDATE tenant_state SET version = version + 1, updated_at = ?
         WHERE tenant_id = ? RETURNING version`,
      )
      .bind(now, tenantId)
      .first<{ version: number }>();
    if (row) return row.version;
    await this.prep(
      "INSERT INTO tenant_state(tenant_id, version, updated_at) VALUES (?, 1, ?)",
      [tenantId, now],
    ).run();
    return 1;
  }

  // -- audit ----------------------------------------------------------------

  async audit(
    tenantId: string,
    entityType: string,
    entityId: string | null,
    action: string,
    payload: unknown = {},
    version = 1,
  ): Promise<void> {
    await this.prep(
      `INSERT INTO audit_log(id, tenant_id, entity_type, entity_id, action, payload_json, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), tenantId, entityType, entityId, action,
        JSON.stringify(payload), nowIso(), nowIso(), version,
      ],
    ).run();
  }

  // -- places ---------------------------------------------------------------

  async listPlaces(tenantId: string, includeArchived = true): Promise<Place[]> {
    const where = includeArchived ? "" : " AND pl.status = 'active'";
    return allRows<Place>(
      await this.prep(
        `SELECT pl.*,
           (SELECT COUNT(*) FROM properties p
            WHERE p.place_id = pl.id AND p.status = 'active' AND p.deleted_at IS NULL) AS active_unit_count,
           (SELECT COUNT(*) FROM properties p
            WHERE p.place_id = pl.id AND p.deleted_at IS NULL) AS total_unit_count
         FROM places pl
         WHERE pl.tenant_id = ? AND pl.deleted_at IS NULL${where}
         ORDER BY CASE pl.status WHEN 'active' THEN 0 ELSE 1 END, pl.name COLLATE NOCASE`,
        [tenantId],
      ).all(),
    );
  }

  async getPlace(tenantId: string, id: string): Promise<Place | null> {
    return firstRow<Place>(
      await this.prep(
        "SELECT * FROM places WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
        [id, tenantId],
      ).first(),
    ) ?? null;
  }

  async createPlace(
    tenantId: string,
    data: Record<string, unknown>,
    lastWriter = "api",
  ): Promise<Place> {
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    const id = crypto.randomUUID();
    try {
      await this.db.batch([
        this.prep(
          `INSERT INTO places(id, tenant_id, name, address, has_food_service, breakfast_price_minor,
             lunch_price_minor, dinner_price_minor, status, notes, created_at, updated_at, version, last_writer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, tenantId, data.name, data.address, data.hasFoodService,
            data.breakfastPriceMinor, data.lunchPriceMinor, data.dinnerPriceMinor,
            data.status, data.notes, now, now, version, lastWriter,
          ],
        ),
        this.auditStmt(tenantId, "place", id, "created", data, version),
      ]);
    } catch (error) {
      throw this.mapUniqueError(error, "places", "Дом отдыха с таким названием уже существует");
    }
    return (await this.getPlace(tenantId, id))!;
  }

  async updatePlace(
    tenantId: string,
    id: string,
    data: Record<string, unknown>,
    lastWriter = "api",
  ): Promise<Place | null> {
    const existing = await this.getPlace(tenantId, id);
    if (!existing) return null;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    try {
      await this.db.batch([
        this.prep(
          `UPDATE places SET name = ?, address = ?, has_food_service = ?, breakfast_price_minor = ?,
             lunch_price_minor = ?, dinner_price_minor = ?, status = ?, notes = ?,
             updated_at = ?, version = ?, last_writer = ?
           WHERE id = ? AND tenant_id = ?`,
          [
            data.name, data.address, data.hasFoodService, data.breakfastPriceMinor,
            data.lunchPriceMinor, data.dinnerPriceMinor, data.status, data.notes,
            now, version, lastWriter, id, tenantId,
          ],
        ),
        this.auditStmt(tenantId, "place", id, "updated", data, version),
      ]);
    } catch (error) {
      throw this.mapUniqueError(error, "places", "Дом отдыха с таким названием уже существует");
    }
    return this.getPlace(tenantId, id);
  }

  async setPlaceStatus(
    tenantId: string,
    id: string,
    status: "active" | "archived",
    lastWriter = "api",
  ): Promise<Place | null> {
    const existing = await this.getPlace(tenantId, id);
    if (!existing) return null;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    await this.db.batch([
      this.prep(
        "UPDATE places SET status = ?, updated_at = ?, version = ?, last_writer = ? WHERE id = ? AND tenant_id = ?",
        [status, now, version, lastWriter, id, tenantId],
      ),
      this.auditStmt(tenantId, "place", id, status === "archived" ? "archived" : "restored", {}, version),
    ]);
    return this.getPlace(tenantId, id);
  }

  async softDeletePlace(tenantId: string, id: string, lastWriter = "api"): Promise<boolean> {
    const existing = await this.getPlace(tenantId, id);
    if (!existing) return false;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    await this.db.batch([
      this.prep(
        "UPDATE places SET deleted_at = ?, updated_at = ?, version = ?, last_writer = ? WHERE id = ? AND tenant_id = ?",
        [now, now, version, lastWriter, id, tenantId],
      ),
      this.auditStmt(tenantId, "place", id, "deleted", { name: existing.name }, version),
    ]);
    return true;
  }

  // -- properties -----------------------------------------------------------

  async listProperties(tenantId: string, includeArchived = true): Promise<Property[]> {
    const where = includeArchived ? "" : " WHERE p.status = 'active'";
    return allRows<Property>(
      await this.prep(
        `SELECT p.*, pl.name AS place_name, pl.address AS place_address,
           (SELECT COUNT(*) FROM reservations r
            WHERE r.property_id = p.id AND r.status NOT IN ('cancelled', 'no_show')
              AND r.deleted_at IS NULL) AS reservation_count
         FROM properties p
         LEFT JOIN places pl ON pl.id = p.place_id AND pl.tenant_id = p.tenant_id
         WHERE p.tenant_id = ? AND p.deleted_at IS NULL${where}
         ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END,
           COALESCE(pl.name, p.name) COLLATE NOCASE, p.name COLLATE NOCASE`,
        [tenantId],
      ).all(),
    );
  }

  async getProperty(tenantId: string, id: string): Promise<Property | null> {
    return firstRow<Property>(
      await this.prep(
        "SELECT * FROM properties WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
        [id, tenantId],
      ).first(),
    ) ?? null;
  }

  async createProperty(
    tenantId: string,
    data: Record<string, unknown>,
    lastWriter = "api",
  ): Promise<Property> {
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    const id = crypto.randomUUID();
    try {
      await this.db.batch([
        this.prep(
          `INSERT INTO properties(id, tenant_id, place_id, kind, name, location, capacity,
             base_price_minor, deposit_minor, currency, check_in_time, check_out_time,
             status, notes, created_at, updated_at, version, last_writer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, tenantId, data.placeId, data.kind, data.name, data.location, data.capacity,
            data.basePriceMinor, data.depositMinor, data.currency, data.checkInTime, data.checkOutTime,
            data.status, data.notes, now, now, version, lastWriter,
          ],
        ),
        this.auditStmt(tenantId, "property", id, "created", data, version),
      ]);
    } catch (error) {
      throw this.mapUniqueError(error, "properties", "Объект с таким наименованием уже существует");
    }
    return (await this.getProperty(tenantId, id))!;
  }

  async updateProperty(
    tenantId: string,
    id: string,
    data: Record<string, unknown>,
    lastWriter = "api",
  ): Promise<Property | null> {
    const existing = await this.getProperty(tenantId, id);
    if (!existing) return null;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    try {
      await this.db.batch([
        this.prep(
          `UPDATE properties SET place_id = ?, kind = ?, name = ?, location = ?, capacity = ?,
             base_price_minor = ?, deposit_minor = ?, currency = ?, check_in_time = ?, check_out_time = ?,
             status = ?, notes = ?, updated_at = ?, version = ?, last_writer = ?
           WHERE id = ? AND tenant_id = ?`,
          [
            data.placeId, data.kind, data.name, data.location, data.capacity,
            data.basePriceMinor, data.depositMinor, data.currency, data.checkInTime, data.checkOutTime,
            data.status, data.notes, now, version, lastWriter, id, tenantId,
          ],
        ),
        this.auditStmt(tenantId, "property", id, "updated", data, version),
      ]);
    } catch (error) {
      throw this.mapUniqueError(error, "properties", "Объект с таким наименованием уже существует");
    }
    return this.getProperty(tenantId, id);
  }

  async setPropertyStatus(
    tenantId: string,
    id: string,
    status: "active" | "archived",
    lastWriter = "api",
  ): Promise<Property | null> {
    const existing = await this.getProperty(tenantId, id);
    if (!existing) return null;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    await this.db.batch([
      this.prep(
        "UPDATE properties SET status = ?, updated_at = ?, version = ?, last_writer = ? WHERE id = ? AND tenant_id = ?",
        [status, now, version, lastWriter, id, tenantId],
      ),
      this.auditStmt(tenantId, "property", id, status === "archived" ? "archived" : "restored", {}, version),
    ]);
    return this.getProperty(tenantId, id);
  }

  async softDeleteProperty(tenantId: string, id: string, lastWriter = "api"): Promise<boolean> {
    const existing = await this.getProperty(tenantId, id);
    if (!existing) return false;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    await this.db.batch([
      this.prep(
        "UPDATE properties SET deleted_at = ?, updated_at = ?, version = ?, last_writer = ? WHERE id = ? AND tenant_id = ?",
        [now, now, version, lastWriter, id, tenantId],
      ),
      this.auditStmt(tenantId, "property", id, "deleted", { name: existing.name }, version),
    ]);
    return true;
  }

  // -- reservations ---------------------------------------------------------

  async listReservations(tenantId: string): Promise<(Reservation & { meals: ReservationMeal[] })[]> {
    const reservations = allRows<Reservation & Record<string, unknown>>(
      await this.prep(
        `SELECT r.*, p.name AS property_name, p.currency, pl.name AS place_name,
           MAX(r.total_minor - r.prepaid_minor, 0) AS balance_minor,
           MAX(r.prepaid_minor - r.total_minor, 0) AS refund_due_minor
         FROM reservations r
         JOIN properties p ON p.id = r.property_id AND p.tenant_id = r.tenant_id
         LEFT JOIN places pl ON pl.id = p.place_id AND pl.tenant_id = r.tenant_id
         WHERE r.tenant_id = ? AND r.deleted_at IS NULL
         ORDER BY r.check_in_date DESC, r.id DESC`,
        [tenantId],
      ).all(),
    );
    const mealsByReservation = new Map<string, ReservationMeal[]>();
    for (const meal of await this.listMeals(tenantId)) {
      const items = mealsByReservation.get(meal.reservation_id) ?? [];
      items.push(meal);
      mealsByReservation.set(meal.reservation_id, items);
    }
    return reservations.map((reservation) => ({
      ...reservation,
      meals: mealsByReservation.get(reservation.id) ?? [],
    }));
  }

  async getReservation(tenantId: string, id: string): Promise<Reservation | null> {
    return firstRow<Reservation>(
      await this.prep(
        "SELECT * FROM reservations WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
        [id, tenantId],
      ).first(),
    ) ?? null;
  }

  async listMeals(tenantId: string): Promise<ReservationMeal[]> {
    return allRows<ReservationMeal>(
      await this.prep(
        "SELECT * FROM reservation_meals WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY meal_date",
        [tenantId],
      ).all(),
    );
  }

  async listNights(tenantId: string, reservationId: string): Promise<{ property_id: string; night_date: string }[]> {
    return allRows<{ property_id: string; night_date: string }>(
      await this.prep(
        "SELECT property_id, night_date FROM reservation_nights WHERE tenant_id = ? AND reservation_id = ? AND deleted_at IS NULL",
        [tenantId, reservationId],
      ).all(),
    );
  }

  async createReservation(
    tenantId: string,
    data: {
      propertyId: string;
      guestName: string;
      guestPhone: string;
      guestEmail: string;
      checkInDate: string;
      checkOutDate: string;
      nights: string[];
      adults: number;
      children: number;
      status: string;
      nightlyRateMinor: number;
      accommodationMinor: number;
      servicesMinor: number;
      totalMinor: number;
      prepaidMinor: number;
      depositMinor: number;
      depositStatus: string;
      actualCheckOutDate: string | null;
      notes: string;
      meals: { meal_date: string; meal_type: string; amount_minor: number }[];
    },
    lastWriter = "api",
  ): Promise<Reservation> {
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    const id = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.prep(
        `INSERT INTO reservations(id, tenant_id, property_id, guest_name, guest_phone, guest_email,
           check_in_date, check_out_date, adults, children, status, nightly_rate_minor,
           accommodation_minor, services_minor, total_minor, prepaid_minor, deposit_minor,
           deposit_status, actual_check_out_date, notes, created_at, updated_at, version, last_writer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, tenantId, data.propertyId, data.guestName, data.guestPhone, data.guestEmail,
          data.checkInDate, data.checkOutDate, data.adults, data.children, data.status,
          data.nightlyRateMinor, data.accommodationMinor, data.servicesMinor, data.totalMinor,
          data.prepaidMinor, data.depositMinor, data.depositStatus, data.actualCheckOutDate,
          data.notes, now, now, version, lastWriter,
        ],
      ),
    ];
    if (data.status !== "cancelled" && data.status !== "no_show") {
      const effectiveNights = data.actualCheckOutDate
        ? data.nights.filter((night) => night < data.actualCheckOutDate!)
        : data.nights;
      for (const night of effectiveNights) {
        statements.push(
          this.prep(
            `INSERT INTO reservation_nights(id, tenant_id, reservation_id, property_id, night_date, created_at, updated_at, version, last_writer)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), tenantId, id, data.propertyId, night, now, now, version, lastWriter],
          ),
        );
      }
    }
    for (const meal of data.meals) {
      statements.push(
        this.prep(
          `INSERT INTO reservation_meals(id, tenant_id, reservation_id, meal_date, meal_type, amount_minor, created_at, updated_at, version, last_writer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), tenantId, id, meal.meal_date, meal.meal_type, meal.amount_minor, now, now, version, lastWriter],
        ),
      );
    }
    statements.push(this.auditStmt(tenantId, "reservation", id, "created", data, version));

    try {
      await this.db.batch(statements);
    } catch (error) {
      throw this.mapOverlapError(error);
    }
    return (await this.getReservation(tenantId, id))!;
  }

  async updateReservation(
    tenantId: string,
    id: string,
    data: {
      propertyId: string;
      guestName: string;
      guestPhone: string;
      guestEmail: string;
      checkInDate: string;
      checkOutDate: string;
      nights: string[];
      adults: number;
      children: number;
      status: string;
      nightlyRateMinor: number;
      accommodationMinor: number;
      servicesMinor: number;
      totalMinor: number;
      prepaidMinor: number;
      depositMinor: number;
      depositStatus: string;
      actualCheckOutDate: string | null;
      notes: string;
      meals: { meal_date: string; meal_type: string; amount_minor: number }[];
    },
    lastWriter = "api",
  ): Promise<Reservation | null> {
    const existing = await this.getReservation(tenantId, id);
    if (!existing) return null;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    const statements: D1PreparedStatement[] = [
      this.prep(
        `UPDATE reservations SET
           property_id = ?, guest_name = ?, guest_phone = ?, guest_email = ?,
           check_in_date = ?, check_out_date = ?, adults = ?, children = ?, status = ?,
           nightly_rate_minor = ?, accommodation_minor = ?, services_minor = ?,
           total_minor = ?, prepaid_minor = ?, deposit_minor = ?, deposit_status = ?,
           actual_check_out_date = ?, notes = ?, updated_at = ?, version = ?, last_writer = ?
         WHERE id = ? AND tenant_id = ?`,
        [
          data.propertyId, data.guestName, data.guestPhone, data.guestEmail,
          data.checkInDate, data.checkOutDate, data.adults, data.children, data.status,
          data.nightlyRateMinor, data.accommodationMinor, data.servicesMinor,
          data.totalMinor, data.prepaidMinor, data.depositMinor, data.depositStatus,
          data.actualCheckOutDate, data.notes, now, version, lastWriter, id, tenantId,
        ],
      ),
      // Soft-delete the previous night/meal rows; fresh ones are inserted below.
      this.prep(
        "UPDATE reservation_nights SET deleted_at = ?, updated_at = ?, version = ?, last_writer = ? WHERE tenant_id = ? AND reservation_id = ? AND deleted_at IS NULL",
        [now, now, version, lastWriter, tenantId, id],
      ),
      this.prep(
        "UPDATE reservation_meals SET deleted_at = ?, updated_at = ?, version = ?, last_writer = ? WHERE tenant_id = ? AND reservation_id = ? AND deleted_at IS NULL",
        [now, now, version, lastWriter, tenantId, id],
      ),
    ];
    if (data.status !== "cancelled" && data.status !== "no_show") {
      const effectiveNights = data.actualCheckOutDate
        ? data.nights.filter((night) => night < data.actualCheckOutDate!)
        : data.nights;
      for (const night of effectiveNights) {
        statements.push(
          this.prep(
            `INSERT INTO reservation_nights(id, tenant_id, reservation_id, property_id, night_date, created_at, updated_at, version, last_writer)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), tenantId, id, data.propertyId, night, now, now, version, lastWriter],
          ),
        );
      }
    }
    for (const meal of data.meals) {
      statements.push(
        this.prep(
          `INSERT INTO reservation_meals(id, tenant_id, reservation_id, meal_date, meal_type, amount_minor, created_at, updated_at, version, last_writer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), tenantId, id, meal.meal_date, meal.meal_type, meal.amount_minor, now, now, version, lastWriter],
        ),
      );
    }
    statements.push(this.auditStmt(tenantId, "reservation", id, "updated", data, version));

    try {
      await this.db.batch(statements);
    } catch (error) {
      throw this.mapOverlapError(error);
    }
    return this.getReservation(tenantId, id);
  }

  async setReservationStatus(
    tenantId: string,
    id: string,
    status: string,
    action: string,
    lastWriter = "api",
  ): Promise<Reservation | null> {
    const existing = await this.getReservation(tenantId, id);
    if (!existing) return null;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    const statements: D1PreparedStatement[] = [
      this.prep(
        "UPDATE reservations SET status = ?, updated_at = ?, version = ?, last_writer = ? WHERE id = ? AND tenant_id = ?",
        [status, now, version, lastWriter, id, tenantId],
      ),
      this.auditStmt(tenantId, "reservation", id, action, { status }, version),
    ];
    if (status === "cancelled" || status === "no_show") {
      statements.push(
        this.prep(
          "UPDATE reservation_nights SET deleted_at = ?, updated_at = ?, version = ?, last_writer = ? WHERE tenant_id = ? AND reservation_id = ? AND deleted_at IS NULL",
          [now, now, version, lastWriter, tenantId, id],
        ),
      );
    }
    await this.db.batch(statements);
    return this.getReservation(tenantId, id);
  }

  async softDeleteReservation(tenantId: string, id: string, lastWriter = "api"): Promise<boolean> {
    const existing = await this.getReservation(tenantId, id);
    if (!existing) return false;
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    await this.db.batch([
      this.prep(
        "UPDATE reservations SET deleted_at = ?, updated_at = ?, version = ?, last_writer = ? WHERE id = ? AND tenant_id = ?",
        [now, now, version, lastWriter, id, tenantId],
      ),
      this.prep(
        "UPDATE reservation_nights SET deleted_at = ?, updated_at = ?, version = ?, last_writer = ? WHERE tenant_id = ? AND reservation_id = ? AND deleted_at IS NULL",
        [now, now, version, lastWriter, tenantId, id],
      ),
      this.prep(
        "UPDATE reservation_meals SET deleted_at = ?, updated_at = ?, version = ?, last_writer = ? WHERE tenant_id = ? AND reservation_id = ? AND deleted_at IS NULL",
        [now, now, version, lastWriter, tenantId, id],
      ),
      this.auditStmt(tenantId, "reservation", id, "deleted", { guestName: existing.guest_name }, version),
    ]);
    return true;
  }

  // -- app settings ---------------------------------------------------------

  async listAppSettings(tenantId: string): Promise<AppSetting[]> {
    return allRows<AppSetting>(
      await this.prep(
        "SELECT * FROM app_settings WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY setting_key",
        [tenantId],
      ).all(),
    );
  }

  async getAppSetting(tenantId: string, key: string): Promise<AppSetting | null> {
    return firstRow<AppSetting>(
      await this.prep(
        "SELECT * FROM app_settings WHERE tenant_id = ? AND setting_key = ? AND deleted_at IS NULL",
        [tenantId, key],
      ).first(),
    ) ?? null;
  }

  async setAppSetting(
    tenantId: string,
    key: string,
    value: string,
    lastWriter = "api",
  ): Promise<AppSetting> {
    const existing = await this.getAppSetting(tenantId, key);
    if (existing) {
      const version = await this.bumpTenantVersion(tenantId);
      const now = nowIso();
      await this.prep(
        "UPDATE app_settings SET setting_value = ?, updated_at = ?, version = ?, last_writer = ? WHERE id = ? AND tenant_id = ?",
        [value, now, version, lastWriter, existing.id, tenantId],
      ).run();
      return (await this.getAppSetting(tenantId, key))!;
    }
    const version = await this.bumpTenantVersion(tenantId);
    const now = nowIso();
    const id = crypto.randomUUID();
    await this.prep(
      `INSERT INTO app_settings(id, tenant_id, setting_key, setting_value, created_at, updated_at, version, last_writer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tenantId, key, value, now, now, version, lastWriter],
    ).run();
    return (await this.getAppSetting(tenantId, key))!;
  }

  // -- sync -----------------------------------------------------------------

  async pullChanges(tenantId: string, since: number): Promise<Record<SyncTable, SyncRow[]>> {
    const result = {} as Record<SyncTable, SyncRow[]>;
    for (const table of SYNC_TABLES) {
      result[table] = allRows<SyncRow>(
        await this.prep(
          `SELECT * FROM ${table} WHERE tenant_id = ? AND version > ? ORDER BY version`,
          [tenantId, since],
        ).all(),
      );
    }
    return result;
  }

  // Last-write-wins upsert of one pushed row. Returns true when the server
  // applied the incoming row, false when the stored row won.
  async pushRow(table: SyncTable, tenantId: string, row: SyncRow): Promise<boolean> {
    const columns = SYNC_COLUMNS[table];
    const clean: SyncRow = {};
    for (const column of columns) if (column in row) clean[column] = row[column];

    clean.tenant_id = tenantId;
    clean.last_writer = String(row.last_writer ?? "unknown") || "unknown";
    const now = nowIso();
    clean.updated_at = String(clean.updated_at ?? now);

    const current = firstRow<SyncRow>(
      await this.prep(`SELECT * FROM ${table} WHERE tenant_id = ? AND id = ?`, [
        tenantId,
        String(clean.id ?? ""),
      ]).first(),
    );
    if (current && rowCompare(clean, current) <= 0) return false;

    const version = await this.bumpTenantVersion(tenantId);
    clean.version = version;

    if (current) {
      // Partial update: only rewrite columns the client sent, so omitted
      // NOT NULL columns keep their stored values instead of becoming NULL.
      const setColumns = columns.filter((c) => c !== "id" && c !== "tenant_id" && c in clean);
      const setClause = setColumns.map((c) => `${c} = ?`).join(", ");
      const values = setColumns.map((c) => clean[c] ?? null);
      await this.prep(`UPDATE ${table} SET ${setClause} WHERE id = ? AND tenant_id = ?`, [
        ...values,
        String(clean.id ?? ""),
        tenantId,
      ]).run();
    } else {
      // New row: omit columns the client did not send so NOT NULL columns
      // fall back to their schema defaults (e.g. price_minor -> 0).
      if (!("created_at" in clean)) clean.created_at = clean.updated_at;
      const writeColumns = columns.filter((c) => c in clean);
      const placeholders = writeColumns.map(() => "?").join(", ");
      const values = writeColumns.map((c) => clean[c] ?? null);
      await this.prep(`INSERT INTO ${table}(${writeColumns.join(", ")}) VALUES (${placeholders})`, values).run();
    }
    return true;
  }

  // -- admin stats ----------------------------------------------------------

  async countAll(table: string): Promise<number> {
    const result = await this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return Number(result?.n ?? 0);
  }

  async listAccounts(): Promise<Account[]> {
    return allRows<Account>(
      await this.db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all(),
    );
  }

  async accountStats(accountId: string): Promise<{
    userCount: number;
    inviteCount: number;
    reservationCount: number;
    syncVersion: number;
    places: number;
    properties: number;
  }> {
    const [users, invites, reservations, state, places, properties] = (await this.db.batch([
      this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE account_id = ?").bind(accountId),
      this.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE account_id = ? AND deleted_at IS NULL").bind(accountId),
      this.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE tenant_id = ? AND deleted_at IS NULL").bind(accountId),
      this.db.prepare("SELECT version FROM tenant_state WHERE tenant_id = ?").bind(accountId),
      this.db.prepare("SELECT COUNT(*) AS n FROM places WHERE tenant_id = ? AND deleted_at IS NULL").bind(accountId),
      this.db.prepare("SELECT COUNT(*) AS n FROM properties WHERE tenant_id = ? AND deleted_at IS NULL").bind(accountId),
    ])) as unknown as [
      D1Result<{ n: number }>,
      D1Result<{ n: number }>,
      D1Result<{ n: number }>,
      D1Result<{ version: number }>,
      D1Result<{ n: number }>,
      D1Result<{ n: number }>,
    ];
    return {
      userCount: Number(users.results?.[0]?.n ?? 0),
      inviteCount: Number(invites.results?.[0]?.n ?? 0),
      reservationCount: Number(reservations.results?.[0]?.n ?? 0),
      syncVersion: Number(state.results?.[0]?.version ?? 0),
      places: Number(places.results?.[0]?.n ?? 0),
      properties: Number(properties.results?.[0]?.n ?? 0),
    };
  }

  async plansBreakdown(): Promise<Record<string, number>> {
    const rows = allRows<{ plan: string; n: number }>(
      await this.db.prepare("SELECT plan, COUNT(*) AS n FROM accounts GROUP BY plan").all(),
    );
    return Object.fromEntries(rows.map((row) => [row.plan, Number(row.n)]));
  }

  // -- helpers --------------------------------------------------------------

  private auditStmt(
    tenantId: string,
    entityType: string,
    entityId: string | null,
    action: string,
    payload: unknown,
    version: number,
  ): D1PreparedStatement {
    return this.prep(
      `INSERT INTO audit_log(id, tenant_id, entity_type, entity_id, action, payload_json, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), tenantId, entityType, entityId, action,
        JSON.stringify(payload), nowIso(), nowIso(), version,
      ],
    );
  }

  private mapUniqueError(error: unknown, table: string, message: string): unknown {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("UNIQUE constraint failed") && text.includes(table)) {
      return new ApiError(400, "validation_error", message);
    }
    return error;
  }

  private mapOverlapError(error: unknown): unknown {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("UNIQUE constraint failed") && text.includes("reservation_nights")) {
      return new ApiError(
        409,
        "night_conflict",
        "На указанные даты дом уже занят другой бронью",
      );
    }
    if (text.includes("UNIQUE constraint failed") && text.includes("reservation_meals")) {
      return new ApiError(400, "validation_error", "Питание за эту дату уже добавлено");
    }
    return error;
  }
}
