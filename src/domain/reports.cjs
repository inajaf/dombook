/**
 * Everything a screen reads, and nothing it writes.
 *
 * These seven were the cleanest seam in `RentKeeperDatabase` when the file was measured: no command
 * in the class calls any of them, and between them they touch only `query`, `scalar`, the
 * `todayProvider` field and each other. That is why they were the second group to move rather than
 * the settings or the outbox, which the file's own notes explain are welded to `enqueueSync`.
 *
 * Keeping reads apart from writes is not tidiness. A query cannot enqueue an outbox row, so a bug
 * in one of these cannot corrupt sync state, and a reader looking for "what does the dashboard
 * count" no longer walks past the booking validators to find it.
 *
 * `store` is the primitives and the clock. Nothing here writes.
 */

const { todayIso } = require("./clock.cjs");
const { integer, validDate } = require("./fields.cjs");


function dashboard(store) {
    const today = todayIso();
    const activeProperties = Number(store.scalar("SELECT COUNT(*) FROM properties WHERE status = 'active'") || 0);
    const activeReservations = Number(store.scalar(
      "SELECT COUNT(*) FROM reservations WHERE status IN ('hold','confirmed','checked_in') AND check_out_date >= ?",
      [today],
    ) || 0);
    const expectedMinor = Number(store.scalar(
      `SELECT COALESCE(SUM(CASE WHEN total_minor > prepaid_minor THEN total_minor - prepaid_minor ELSE 0 END), 0)
       FROM reservations
       WHERE status IN ('hold','confirmed','checked_in')`,
    ) || 0);
    const refundsDueMinor = Number(store.scalar(
      `SELECT COALESCE(SUM(CASE WHEN prepaid_minor > total_minor THEN prepaid_minor - total_minor ELSE 0 END), 0)
       FROM reservations WHERE status = 'checked_out'`,
    ) || 0);
    const depositsHeldMinor = Number(store.scalar(
      `SELECT COALESCE(SUM(deposit_minor), 0)
       FROM reservations
       WHERE deposit_status IN ('received','partially_withheld')`,
    ) || 0);
    const arrivals = store.query(
      `SELECT r.*, p.name AS property_name, pl.name AS place_name
       FROM reservations r JOIN properties p ON p.id = r.property_id
       LEFT JOIN places pl ON pl.id = p.place_id
       WHERE r.check_in_date = ? AND r.status NOT IN ('cancelled','no_show')
       ORDER BY p.name`,
      [today],
    );
    const departures = store.query(
      `SELECT r.*, p.name AS property_name, pl.name AS place_name
       FROM reservations r JOIN properties p ON p.id = r.property_id
       LEFT JOIN places pl ON pl.id = p.place_id
       WHERE r.check_out_date = ? AND r.status NOT IN ('cancelled','no_show')
       ORDER BY p.name`,
      [today],
    );
    return { today, activeProperties, activeReservations, expectedMinor, refundsDueMinor, depositsHeldMinor, arrivals, departures };
  }

  /**
   * The occupancy grid for a window of days.
   *
   * `startDate` is what makes the calendar navigable: without it the window always began today,
   * so "previous period" could only ever have shown the same two weeks. It is an ISO date rather
   * than an offset so that a window means the same dates on every device and in a bookmark,
   * instead of shifting with whatever "today" happens to be when it is read.
   *
   * Defaults to today, which keeps every existing caller — and anything holding a stored window —
   * working unchanged.
   */


function listReservations(store) {
    const reservations = store.query(`
      SELECT r.*, p.name AS property_name, p.currency, pl.name AS place_name,
        MAX(r.total_minor - r.prepaid_minor, 0) AS balance_minor,
        MAX(r.prepaid_minor - r.total_minor, 0) AS refund_due_minor
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      LEFT JOIN places pl ON pl.id = p.place_id
      ORDER BY r.check_in_date DESC, r.created_at DESC, r.id DESC
    `);
    const mealsByReservation = new Map();
    store.query(`
      SELECT reservation_id, meal_date, meal_type, amount_minor
      FROM reservation_meals
      ORDER BY meal_date, CASE meal_type
        WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END
    `).forEach((meal) => {
      const items = mealsByReservation.get(meal.reservation_id) || [];
      items.push(meal);
      mealsByReservation.set(meal.reservation_id, items);
    });
    return reservations.map((reservation) => ({
      ...reservation,
      meals: mealsByReservation.get(reservation.id) || [],
    }));
  }



  /**
   * The details a contract or an invoice has to carry to be worth anything to an accountant.
   *
   * Stored as one JSON blob in app_settings rather than as columns on an `accounts` row: the set
   * of requisites a jurisdiction wants varies (VÖEN here, ИНН and КПП a border away), and a schema
   * with one column per field would need a migration for every country the product is sold in.
   * app_settings already replicates, so the details reach every device the owner signs in on.
   *
   * Read tolerantly: a half-filled or unreadable value must degrade to "not filled in yet" so the
   * document can still be produced with blank lines, rather than failing the generation.
   */
function documentRequisites(store) {
    const fallback = {
      lessorName: "",
      lessorTaxId: "",
      lessorAddress: "",
      lessorPhone: "",
      bankDetails: "",
      signatoryName: "",
      documentCity: "",
    };
    const stored = store.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'document_requisites'",
    );
    if (!stored) return fallback;
    try {
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object") return fallback;
      return Object.fromEntries(Object.entries(fallback).map(([key, value]) => [
        key,
        typeof parsed[key] === "string" ? parsed[key].trim().slice(0, 300) : value,
      ]));
    } catch {
      return fallback;
    }
  }



  /**
   * The account's entitlements, as most recently reported by the server.
   *
   * Cached locally for the same reason the booking policy is: the application must work
   * offline, and a licence check that needed the network would make the app unusable on a
   * train. The server stays authoritative — it re-checks on every write that matters — so
   * this cache can only ever be too permissive for a short window, never permanently.
   */
function entitlements(store) {
    const stored = store.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'entitlements'",
    );
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      // `unitLimit: null` means unlimited, so the distinction between "no cache" and
      // "unlimited" has to survive JSON. Reading a missing field as unlimited would hand
      // out the paid tier on a corrupt cache.
      return {
        paid: parsed.paid === true,
        planName: typeof parsed.planName === "string" ? parsed.planName : "",
        skus: Array.isArray(parsed.skus) ? parsed.skus : [],
        expiresAt: parsed.expiresAt ?? null,
        // A missing unitLimit with paid=false is treated as the free cap rather than as
        // unlimited, so the failure mode is a refusal instead of a giveaway.
        unitLimit: parsed.paid === true && parsed.unitLimit === null
          ? null
          : Number.isInteger(parsed.unitLimit) ? parsed.unitLimit : 1,
        features: Array.isArray(parsed.features) ? parsed.features : [],
        cachedAt: parsed.cachedAt ?? null,
        stale: true,
      };
    } catch {
      return null;
    }
  }

  /** Record the entitlements the server reported. */


  /**
   * The occupancy grid for a window of days.
   *
   * `startDate` is what makes the calendar navigable: without it the window always began today,
   * so "previous period" could only ever have shown the same two weeks. It is an ISO date rather
   * than an offset so that a window means the same dates on every device and in a bookmark,
   * instead of shifting with whatever "today" happens to be when it is read.
   *
   * Defaults to today, which keeps every existing caller — and anything holding a stored window —
   * working unchanged.
   */
function calendar(store, days = 14, startDate = null) {
    const safeDays = integer(days, "Период календаря", 7, 60);
    // `store.todayProvider`, not the module clock: the account's time zone (and a test's idea of
    // today) decide the window, the same way they decide every other date in the domain.
    const from = startDate ? validDate(startDate, "Начало периода") : store.todayProvider();
    const start = new Date(`${from}T00:00:00Z`);
    const dates = Array.from({ length: safeDays }, (_, index) =>
      new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    );
    const properties = listProperties(store, { includeArchived: false });
    const occupancy = store.query(
      `SELECT rn.property_id, rn.night_date, r.id AS reservation_id, r.guest_name, r.status
       FROM reservation_nights rn
       JOIN reservations r ON r.id = rn.reservation_id
       WHERE rn.night_date >= ? AND rn.night_date < ?
       ORDER BY rn.night_date`,
      [dates[0], new Date(start.getTime() + safeDays * 86_400_000).toISOString().slice(0, 10)],
    );
    // `startDate` is echoed back: the renderer asked for a window and gets to know which one it
    // received, rather than recomputing it and drifting a day on a timezone boundary.
    return { dates, startDate: dates[0], properties, occupancy };
  }



function listProperties(store, { includeArchived = true } = {}) {
    const where = includeArchived ? "" : "WHERE p.status = 'active'";
    return store.query(`
      SELECT p.*, pl.name AS place_name, pl.address AS place_address,
        (SELECT COUNT(*) FROM reservations r
          WHERE r.property_id = p.id AND r.status NOT IN ('cancelled', 'no_show')) AS reservation_count
      FROM properties p
      LEFT JOIN places pl ON pl.id = p.place_id
      ${where}
      ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END,
        COALESCE(pl.name, p.name) COLLATE NOCASE, p.name COLLATE NOCASE
    `);
  }



function listPlaces(store, { includeArchived = true } = {}) {
    const where = includeArchived ? "" : "WHERE pl.status = 'active'";
    return store.query(`
      SELECT pl.*,
        (SELECT COUNT(*) FROM properties p WHERE p.place_id = pl.id AND p.status = 'active') AS active_unit_count,
        (SELECT COUNT(*) FROM properties p WHERE p.place_id = pl.id) AS total_unit_count
      FROM places pl
      ${where}
      ORDER BY CASE pl.status WHEN 'active' THEN 0 ELSE 1 END, pl.name COLLATE NOCASE
    `);
  }


module.exports = {
  dashboard,
  listReservations,
  documentRequisites,
  entitlements,
  calendar,
  listProperties,
  listPlaces,
};
