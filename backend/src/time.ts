// Mirrors the desktop booking policy (src/domain/booking/booking-policy.cjs)
// so cloud and desktop enforce identical rules. Kept independent so the
// backend can run without the Electron source tree.

export const BOOKING_POLICY = Object.freeze({
  maximumAdvanceDays: 21,
  maximumStayMonths: 3,
  timeZone: "Asia/Baku",
});

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDaysIso(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addCalendarMonths(value: string, months: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year!, month! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day!, lastDay));
  return target.toISOString().slice(0, 10);
}

export function todayInTimeZone(date = new Date(), timeZone = BOOKING_POLICY.timeZone): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function bookingLimits(checkInDate: string | null, today = todayInTimeZone()) {
  return {
    today,
    maximumCheckInDate: addDaysIso(today, BOOKING_POLICY.maximumAdvanceDays),
    maximumCheckOutDate: checkInDate
      ? addCalendarMonths(checkInDate, BOOKING_POLICY.maximumStayMonths)
      : null,
    ...BOOKING_POLICY,
  };
}

export interface ExistingReservationDates {
  check_in_date: string;
  check_out_date: string;
}

export function assertBookingDates({
  checkInDate,
  checkOutDate,
  today = todayInTimeZone(),
  existingReservation = null,
}: {
  checkInDate: string;
  checkOutDate: string;
  today?: string;
  existingReservation?: ExistingReservationDates | null;
}) {
  const isNew = !existingReservation;
  const checkInChanged = isNew || existingReservation!.check_in_date !== checkInDate;
  const checkOutChanged = isNew || existingReservation!.check_out_date !== checkOutDate;
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
  if (checkOutDate > limits.maximumCheckOutDate!) {
    throw new Error(
      `Проживание не может быть дольше ${BOOKING_POLICY.maximumStayMonths} календарных месяцев — выезд не позже ${limits.maximumCheckOutDate}`,
    );
  }
}
