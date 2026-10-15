/**
 * Turning domain values into the words and numbers a person reads.
 *
 * Pure: no DOM, no state, no IPC. The renderer is sandboxed and cannot load the shared domain
 * module, so anything that needs a CALCULATION is asked of the main process — these functions only
 * present what they are given.
 */

export const interfaceLocale = () => window.i18n?.locale || "ru-RU";

export const interfaceLanguage = () => window.i18n?.language || "ru";

/**
 * Interface text size.
 *
 * Everything in styles.css is sized from `--text-scale`, so this is the whole implementation of
 * "make it readable" — one number. It is a property of the SCREEN rather than of the business:
 * a 60-year-old owner on a laptop wants large type, the same account on a wall-mounted office
 * display does not, and neither should sync the other's preference. That is why it lives in
 * localStorage and not in app_settings, which the server replicates.
 */
/**
 * The theme switch.
 *
 * The choice is light/dark/auto; the DOCUMENT always carries a resolved light or dark, because the
 * stylesheet has one dark block and a media-query copy would be a second palette to keep in step.
 * The pre-paint bootstrap in js/theme-boot.js owns reading and applying it; this only drives the
 * two controls and keeps them agreeing with each other.
 *
 * Like the text size, and for the same reason: it is a device preference, not account data.
 * `app_settings` replicates, so syncing a theme would let one device repaint another.
 */

/**
 * Today, spelled out for the header: "Четверг, 15 октября".
 *
 * The dashboard's eyebrow used to read "Рабочий день", which is the same every day and therefore
 * tells the reader nothing they did not already know. A date is the one fact that changes, and it
 * is the fact an owner opening the app first checks — the weekday especially, because it decides
 * whether the weekend's arrivals are today's problem.
 */
export function todayLabel(today) {
  const iso = today || new Date().toISOString().slice(0, 10);
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  const weekday = new Intl.DateTimeFormat(interfaceLocale(), { weekday: "long" }).format(parsed);
  const rest = new Intl.DateTimeFormat(interfaceLocale(), { day: "numeric", month: "long" }).format(parsed);
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${rest}`;
}

export function money(minor, currency = "AZN") {
  return new Intl.NumberFormat(interfaceLocale(), {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(minor || 0) / 100);
}

export function objectCountLabel(count) {
  const value = Number(count || 0);
  if (interfaceLanguage() === "en") return `${value} ${value === 1 ? "property" : "properties"}`;
  if (interfaceLanguage() === "az") return `${value} obyekt`;
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${value} объектов`;
  if (mod10 === 1) return `${value} объект`;
  if (mod10 >= 2 && mod10 <= 4) return `${value} объекта`;
  return `${value} объектов`;
}

export function guestCountLabel(count) {
  const value = Number(count || 0);
  if (interfaceLanguage() === "en") return `${value} ${value === 1 ? "guest" : "guests"}`;
  if (interfaceLanguage() === "az") return `${value} qonaq`;
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${value} гостей`;
  if (mod10 === 1) return `${value} гость`;
  if (mod10 >= 2 && mod10 <= 4) return `${value} гостя`;
  return `${value} гостей`;
}

export function capacityLabel(count) {
  if (interfaceLanguage() === "en") return `up to ${guestCountLabel(count)}`;
  if (interfaceLanguage() === "az") return `maksimum ${guestCountLabel(count)}`;
  return `до ${Number(count || 0)} гостей`;
}

export function bookingWindowHelp(fromDate, toDate) {
  if (interfaceLanguage() === "en") return `Check-in can be selected from ${longDate(fromDate)} to ${longDate(toDate)}.`;
  if (interfaceLanguage() === "az") return `Giriş ${longDate(fromDate)} tarixindən ${longDate(toDate)} tarixinədək seçilə bilər.`;
  return `Можно выбрать заезд с ${longDate(fromDate)} по ${longDate(toDate)}.`;
}

export function maximumCheckoutHelp(date) {
  if (interfaceLanguage() === "en") return `For the selected check-in, checkout must be no later than ${longDate(date)}.`;
  if (interfaceLanguage() === "az") return `Seçilmiş giriş üçün çıxış ${longDate(date)} tarixindən gec olmamalıdır.`;
  return `Для выбранного заезда — не позже ${longDate(date)}.`;
}

export function maximumStayHelp(months) {
  if (interfaceLanguage() === "en") return `Maximum stay is ${months} calendar months.`;
  if (interfaceLanguage() === "az") return `Maksimum qalma müddəti ${months} təqvim ayıdır.`;
  return `Проживание — максимум ${months} календарных месяца.`;
}

export function balanceLabel(reservation) {
  const value = reservation.refund_due_minor > 0
    ? money(reservation.refund_due_minor, reservation.currency)
    : money(reservation.balance_minor, reservation.currency);
  if (reservation.refund_due_minor > 0) {
    if (interfaceLanguage() === "en") return `refund ${value}`;
    if (interfaceLanguage() === "az") return `qaytarılacaq ${value}`;
    return `к возврату ${value}`;
  }
  if (interfaceLanguage() === "en") return `balance ${value}`;
  if (interfaceLanguage() === "az") return `qalıq ${value}`;
  return `остаток ${value}`;
}

export function shortDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(interfaceLocale(), { day: "2-digit", month: "short" })
    .format(new Date(`${value}T00:00:00`))
    .replace(".", "");
}

export function longDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(interfaceLocale(), { day: "numeric", month: "long", year: "numeric" })
    .format(new Date(`${value}T00:00:00`));
}

export function decimalToMinor(value) {
  return Math.round(Number(value || 0) * 100);
}

export function minorToDecimal(value) {
  return (Number(value || 0) / 100).toFixed(2);
}

export function addDaysIso(value, days = 1) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function nightsBetween(checkInDate, checkOutDate) {
  if (!checkInDate || !checkOutDate) return 0;
  const checkIn = new Date(`${checkInDate}T00:00:00Z`);
  const checkOut = new Date(`${checkOutDate}T00:00:00Z`);
  const nights = Math.round((checkOut - checkIn) / 86_400_000);
  return Number.isFinite(nights) && nights > 0 ? nights : 0;
}

export function addCalendarMonthsIso(value, months) {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The night count with the right Russian form, which the app already needed elsewhere. */
export function nightLabel(count) {
  if (interfaceLanguage() === "en") return count === 1 ? "night" : "nights";
  if (interfaceLanguage() === "az") return "gecə";
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "ночей";
  if (mod10 === 1) return "ночь";
  if (mod10 >= 2 && mod10 <= 4) return "ночи";
  return "ночей";
}

/** "мес." with the right form, which the app already needed for the rentals page. */

/** "мес." with the right form, which the app already needed for the rentals page. */
export function monthLabel(months) {
  if (interfaceLanguage() === "en") return months === 1 ? "month" : "months";
  if (interfaceLanguage() === "az") return "ay";
  const mod100 = months % 100;
  const mod10 = months % 10;
  if (mod100 >= 11 && mod100 <= 14) return "месяцев";
  if (mod10 === 1) return "месяц";
  if (mod10 >= 2 && mod10 <= 4) return "месяца";
  return "месяцев";
}

/**
 * The one-line explanation above the total.
 *
 * It is the answer to "why is it this much?", which is the question a season raises: a stay whose
 * nights are not all the same price cannot be summarised as a rate times a count.
 */

/**
 * The one-line explanation above the total.
 *
 * It is the answer to "why is it this much?", which is the question a season raises: a stay whose
 * nights are not all the same price cannot be summarised as a rate times a count.
 */
export function formulaLabel(quote, property, currency) {
  if (!quote) return "Выберите корректные даты";
  if (quote.kind === "rental") {
    const base = `${quote.months} × ${money(quote.monthlyRateMinor, property?.currency)}`;
    return quote.discountPercent
      ? `${base} − ${quote.discountPercent}% = ${money(quote.effectiveMonthlyMinor, property?.currency)}/мес`
      : base;
  }
  if (!quote.nights) return "Выберите корректные даты";
  const distinct = new Set(quote.lines.map((line) => line.nightlyRateMinor));
  if (distinct.size === 1) return `${money(quote.lines[0].nightlyRateMinor, property?.currency)} × ${quote.nights}`;
  return quote.lines
    .map((line) => `${line.nights} × ${money(line.nightlyRateMinor, property?.currency)}`)
    .join(" + ");
}

/**
 * Ask the main process what this booking costs, and show it.
 *
 * The arithmetic is NOT repeated here. The renderer is sandboxed and cannot load the pricing
 * module, and a second copy of seasons and discounts in the view is exactly the drift the shared
 * fixtures exist to prevent — the preview would then disagree with the amount the save stores.
 *
 * A quote that arrives out of order is dropped rather than rendered: two keystrokes in the date
 * field produce two requests, and the slower one is not the newer one.
 */

export function privateStorageLabel(value, fallback) {
  if (!value) return fallback;
  if (value === "Browser local storage" || value === "Browser downloads") return value;
  const segments = String(value).split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || fallback;
}

export function formatBytes(bytes) {
  const units = interfaceLanguage() === "ru" ? ["Б", "КБ", "МБ"] : ["B", "KB", "MB"];
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} ${units[1]}`;
  return `${(bytes / 1_048_576).toFixed(1)} ${units[2]}`;
}

export function reservationStatusLabel(status) {
  return RESERVATION_STATUS_LABELS[status] || status || "";
}

/** Parse stored meter readings, tolerating anything unreadable. */

/**
 * The Russian label for a reservation status.
 *
 * The rentals page rendered the raw stored value ("HOLD"), which is an internal token rather
 * than something an owner should read. An unknown status falls back to the raw value so a new
 * status is visible rather than blank.
 */
const RESERVATION_STATUS_LABELS = {
  hold: "Предварительная",
  confirmed: "Подтверждена",
  checked_in: "Гость в доме",
  checked_out: "Завершена",
  cancelled: "Отменена",
  no_show: "Не приехал",
  conflict: "Конфликт",
};

/**
 * Who may sign in to this account, and who has been invited.
 *
 * Isolation between accounts is the default and is enforced on the server; this panel is the only
 * place access is GRANTED. Two rules are the server's, and the panel states them rather than
 * pretending otherwise: an invitation belongs to one email address, and it can never grant
 * ownership.
 */
export const ROLE_LABELS = {
  owner: "Владелец",
  admin: "Администратор",
  staff: "Сотрудник",
};

export const STATUS_LABELS = {
  hold: "Холд",
  confirmed: "Подтверждена",
  checked_in: "Заехал",
  checked_out: "Выехал",
  cancelled: "Отменена",
  no_show: "Не заехал",
};

export const DEPOSIT_LABELS = {
  none: "Не требуется",
  due: "Ожидается",
  received: "Получен",
  returned: "Возвращён",
  partially_withheld: "Частично удержан",
  withheld: "Удержан",
};
