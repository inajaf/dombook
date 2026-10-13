const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BOOKING_POLICY,
  addCalendarMonths,
  assertBookingDates,
  bookingLimits,
  resolvePolicy,
  todayInTimeZone,
} = require("../src/domain/booking/booking-policy.cjs");

test("окно новой брони заканчивается ровно через 21 день", () => {
  assert.deepEqual(bookingLimits("2026-08-19", "2026-07-29"), {
    today: "2026-07-29",
    maximumCheckInDate: "2026-08-19",
    maximumCheckOutDate: "2026-11-19",
    maximumAdvanceDays: 21,
    maximumStayMonths: 3,
    timeZone: "Asia/Baku",
  });
  assert.doesNotThrow(() => assertBookingDates({
    checkInDate: "2026-08-19",
    checkOutDate: "2026-08-20",
    today: "2026-07-29",
  }));
  assert.throws(() => assertBookingDates({
    checkInDate: "2026-08-20",
    checkOutDate: "2026-08-21",
    today: "2026-07-29",
  }), /максимум на 21 день/);
});

test("новая бронь в прошлом запрещена", () => {
  assert.throws(() => assertBookingDates({
    checkInDate: "2026-07-28",
    checkOutDate: "2026-07-29",
    today: "2026-07-29",
  }), /не может быть в прошлом/);
});

test("три календарных месяца учитывают короткие месяцы и високосный год", () => {
  assert.equal(addCalendarMonths("2026-01-31", 3), "2026-04-30");
  assert.equal(addCalendarMonths("2028-11-30", 3), "2029-02-28");
  assert.doesNotThrow(() => assertBookingDates({
    checkInDate: "2026-08-01",
    checkOutDate: "2026-11-01",
    today: "2026-07-29",
  }));
  assert.throws(() => assertBookingDates({
    checkInDate: "2026-08-01",
    checkOutDate: "2026-11-02",
    today: "2026-07-29",
  }), /дольше 3 календарных месяцев/);
});

test("дата сегодня рассчитывается в часовом поясе Баку", () => {
  assert.equal(todayInTimeZone(new Date("2026-07-28T20:30:00Z")), "2026-07-29");
});

test("старую бронь можно финансово редактировать, но нельзя расширить сверх лимита", () => {
  const existingReservation = {
    check_in_date: "2026-01-01",
    check_out_date: "2026-05-01",
  };
  assert.doesNotThrow(() => assertBookingDates({
    checkInDate: "2026-01-01",
    checkOutDate: "2026-05-01",
    today: "2026-07-29",
    existingReservation,
  }));
  assert.throws(() => assertBookingDates({
    checkInDate: "2026-01-01",
    checkOutDate: "2026-05-02",
    today: "2026-07-29",
    existingReservation,
  }), /дольше 3 календарных месяцев/);
});


// --- account-level policy ---------------------------------------------------

test("окно бронирования берётся из политики аккаунта", () => {
  // A device and the server must agree on what is bookable. The client applies the window
  // the server reports, so a date accepted locally is not refused on push.
  const policy = { maximumAdvanceDays: 60, maximumStayMonths: 6, timeZone: "UTC" };

  const limits = bookingLimits("2026-08-11", "2026-08-11", policy);
  assert.equal(limits.maximumAdvanceDays, 60);
  assert.equal(limits.maximumStayMonths, 6);
  assert.equal(limits.maximumCheckInDate, "2026-10-10", "60 дней от 11 августа");
  assert.equal(limits.timeZone, "UTC");

  // A booking 40 days out is refused under the default window and accepted under this one.
  assert.throws(() => assertBookingDates({
    checkInDate: "2026-09-20",
    checkOutDate: "2026-09-22",
    today: "2026-08-11",
  }), /максимум на 21 день/);
  assert.doesNotThrow(() => assertBookingDates({
    checkInDate: "2026-09-20",
    checkOutDate: "2026-09-22",
    today: "2026-08-11",
    policy,
  }));
});

test("сужение окна запрещает ранее допустимые даты", () => {
  const policy = { maximumAdvanceDays: 7, maximumStayMonths: 1, timeZone: "Asia/Baku" };
  // Ten days out: inside the default window, beyond the narrowed one.
  assert.throws(() => assertBookingDates({
    checkInDate: "2026-08-21",
    checkOutDate: "2026-08-23",
    today: "2026-08-11",
    policy,
  }), /максимум на 7 день/);
});

test("испорченная политика откатывается к значениям по умолчанию", () => {
  // A malformed policy must not lock the calendar: zero would forbid every booking, so an
  // unreadable value degrades to the shipped default rather than closing the app.
  for (const broken of [
    { maximumAdvanceDays: 0, maximumStayMonths: 3, timeZone: "Asia/Baku" },
    { maximumAdvanceDays: -5, maximumStayMonths: 3, timeZone: "Asia/Baku" },
    { maximumAdvanceDays: 21, maximumStayMonths: 0, timeZone: "Asia/Baku" },
    { maximumAdvanceDays: "21", maximumStayMonths: 3, timeZone: "Asia/Baku" },
    { maximumAdvanceDays: 21, maximumStayMonths: 3, timeZone: "" },
    { maximumAdvanceDays: 21, maximumStayMonths: 3 },
    {},
    null,
    undefined,
    "not an object",
  ]) {
    const resolved = resolvePolicy(broken);
    assert.equal(resolved.maximumAdvanceDays, BOOKING_POLICY.maximumAdvanceDays,
      `advance days should fall back for ${JSON.stringify(broken)}`);
    assert.equal(resolved.maximumStayMonths, BOOKING_POLICY.maximumStayMonths);
    assert.equal(resolved.timeZone, BOOKING_POLICY.timeZone);
  }
});

test("политика аккаунта не мешает редактировать старую бронь", () => {
  // An existing booking whose dates are unchanged must stay editable even if the window has
  // since narrowed, or every old booking would become permanently unmodifiable.
  const narrowed = { maximumAdvanceDays: 7, maximumStayMonths: 1, timeZone: "Asia/Baku" };
  assert.doesNotThrow(() => assertBookingDates({
    checkInDate: "2020-01-01",
    checkOutDate: "2020-01-03",
    today: "2026-08-11",
    existingReservation: { check_in_date: "2020-01-01", check_out_date: "2020-01-03" },
    policy: narrowed,
  }));
});
