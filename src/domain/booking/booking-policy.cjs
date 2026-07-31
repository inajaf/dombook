const BOOKING_POLICY = Object.freeze({
  maximumAdvanceDays: 21,
  maximumStayMonths: 3,
  timeZone: "Asia/Baku",
});

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

function bookingLimits(checkInDate, today = todayInTimeZone()) {
  return {
    today,
    maximumCheckInDate: addDaysIso(today, BOOKING_POLICY.maximumAdvanceDays),
    maximumCheckOutDate: checkInDate
      ? addCalendarMonths(checkInDate, BOOKING_POLICY.maximumStayMonths)
      : null,
    ...BOOKING_POLICY,
  };
}

function assertBookingDates({
  checkInDate,
  checkOutDate,
  today = todayInTimeZone(),
  existingReservation = null,
}) {
  const isNew = !existingReservation;
  const checkInChanged = isNew || existingReservation.check_in_date !== checkInDate;
  const checkOutChanged = isNew || existingReservation.check_out_date !== checkOutDate;
  if (!checkInChanged && !checkOutChanged) return;

  const limits = bookingLimits(checkInDate, today);
  if (checkInChanged && checkInDate < limits.today) {
    throw new Error("Дата заезда не может быть в прошлом");
  }
  if (checkInChanged && checkInDate > limits.maximumCheckInDate) {
    throw new Error(
      `Заезд можно оформить максимум на ${BOOKING_POLICY.maximumAdvanceDays} день вперёд — до ${limits.maximumCheckInDate}`,
    );
  }
  if (checkOutDate > limits.maximumCheckOutDate) {
    throw new Error(
      `Проживание не может быть дольше ${BOOKING_POLICY.maximumStayMonths} календарных месяцев — выезд не позже ${limits.maximumCheckOutDate}`,
    );
  }
}

module.exports = {
  BOOKING_POLICY,
  addCalendarMonths,
  addDaysIso,
  assertBookingDates,
  bookingLimits,
  todayInTimeZone,
};
