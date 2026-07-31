const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addCalendarMonths,
  assertBookingDates,
  bookingLimits,
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
