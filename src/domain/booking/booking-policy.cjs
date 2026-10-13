/**
 * The shipped booking policy, used when an account has not configured one.
 *
 * This is a DEFAULT, not the rule. The server stores a per-account window and reports it
 * through /account/booking-policy; the client follows that value so a device cannot offer
 * dates the server refuses. The constants here must stay equal to `domain.DefaultPolicy`
 * in the Go server, or a fresh account would see one window locally and another remotely.
 */
const BOOKING_POLICY = Object.freeze({
  maximumAdvanceDays: 21,
  maximumStayMonths: 3,
  timeZone: "Asia/Baku",
});

/**
 * Merge a partial policy onto the defaults.
 *
 * Anything missing or nonsensical falls back to the shipped value. A window of zero days
 * would forbid every booking, so a malformed value must not become a lockout: an
 * unreadable policy should degrade to the default rather than close the calendar.
 */
function resolvePolicy(override) {
  if (!override || typeof override !== "object") return BOOKING_POLICY;
  const positive = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  const zone = typeof override.timeZone === "string" && override.timeZone.trim()
    ? override.timeZone.trim()
    : BOOKING_POLICY.timeZone;
  return Object.freeze({
    maximumAdvanceDays: positive(override.maximumAdvanceDays, BOOKING_POLICY.maximumAdvanceDays),
    maximumStayMonths: positive(override.maximumStayMonths, BOOKING_POLICY.maximumStayMonths),
    timeZone: zone,
  });
}

function addDaysIso(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addCalendarMonths(value, months) {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function todayInTimeZone(date = new Date(), timeZone = BOOKING_POLICY.timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function bookingLimits(checkInDate, today = todayInTimeZone(), policy = BOOKING_POLICY) {
  const effective = resolvePolicy(policy);
  return {
    today,
    maximumCheckInDate: addDaysIso(today, effective.maximumAdvanceDays),
    maximumCheckOutDate: checkInDate
      ? addCalendarMonths(checkInDate, effective.maximumStayMonths)
      : null,
    ...effective,
  };
}

/**
 * Validate a stay against the account's booking window.
 *
 * `policy` comes from the server when it is reachable. The client applies the same rule the
 * server will apply on push, so the user is told "too far ahead" while booking rather than
 * discovering it when the change syncs.
 *
 * The check order and the unchanged-dates skip are part of the contract with the Go
 * validator; both are pinned by fixtures/booking-policy-cases.json.
 */
function assertBookingDates({
  checkInDate,
  checkOutDate,
  today = todayInTimeZone(),
  existingReservation = null,
  policy = BOOKING_POLICY,
}) {
  const effective = resolvePolicy(policy);
  const isNew = !existingReservation;
  const checkInChanged = isNew || existingReservation.check_in_date !== checkInDate;
  const checkOutChanged = isNew || existingReservation.check_out_date !== checkOutDate;
  if (!checkInChanged && !checkOutChanged) return;

  const limits = bookingLimits(checkInDate, today, effective);
  if (checkInChanged && checkInDate < limits.today) {
    throw new Error("Дата заезда не может быть в прошлом");
  }
  if (checkInChanged && checkInDate > limits.maximumCheckInDate) {
    throw new Error(
      `Заезд можно оформить максимум на ${effective.maximumAdvanceDays} день вперёд — до ${limits.maximumCheckInDate}`,
    );
  }
  if (checkOutDate > limits.maximumCheckOutDate) {
    throw new Error(
      `Проживание не может быть дольше ${effective.maximumStayMonths} календарных месяцев — выезд не позже ${limits.maximumCheckOutDate}`,
    );
  }
}

module.exports = {
  BOOKING_POLICY,
  resolvePolicy,
  addCalendarMonths,
  addDaysIso,
  assertBookingDates,
  bookingLimits,
  todayInTimeZone,
};
