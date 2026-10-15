/**
 * The screen's state, and the labels the views share.
 *
 * One mutable object, deliberately: every write re-reads it and redraws, and a reactive layer in
 * between would be more machinery than this interface needs.
 */

export const PAGE_META = {
  dashboard: { eyebrow: "Рабочий день", title: "Сегодня", action: "Новая бронь", actionType: "reservation", search: false },
  calendar: { eyebrow: "Доступность", title: "Календарь", action: "Новая бронь", actionType: "reservation", search: false },
  reservations: { eyebrow: "Гости и деньги", title: "Бронирования", action: "Новая бронь", actionType: "reservation", search: true },
  properties: { eyebrow: "Инвентарь", title: "Объекты", action: "Добавить объект", actionType: "property", search: true },
  rentals: { eyebrow: "Договоры", title: "Аренда", action: "Новый договор", actionType: "rental", search: true },
  conflicts: { eyebrow: "Целостность данных", title: "Конфликты", action: "Новая бронь", actionType: "reservation", search: false },
  settings: { eyebrow: "Надёжность", title: "Настройки", action: "Создать backup", actionType: "backup", search: false },
};

export const state = {
  page: "dashboard",
  places: [],
  properties: [],
  reservations: [],
  dashboard: null,
  calendar: null,
  // Which window the calendar covers. Part of the STATE rather than of the view because a redraw
  // must not silently reset it — the owner pages back, saves a booking, and stays where they were.
  calendarDays: 14,
  calendarStart: null,
  backups: [],
  systemInfo: null,
  // The price of the booking being edited, as computed by the main process. Null until the
  // dates and the unit are both chosen.
  quote: null,
  // Bumped per request so a slow quote cannot overwrite a newer one.
  quoteRequest: 0,
  // Set when this sign-in created the account (the address was not loginable a moment ago).
  accountCreated: false,
  // True once the owner types an amount: the computed figure stops replacing it.
  accommodationManual: false,
  // The booking the documents dialog is currently about, and where generated documents live.
  documentsReservation: null,
  documentsFolder: "",
  reservationFilter: "all",
  search: "",
  expandedGroups: new Set(),
  session: null,
  authBaseUrl: null,
  // Conflicts are bookings that arrived from a device that was offline and collided with
  // dates already sold. They are stored rather than rejected, so they are visible here
  // instead of silently missing from the calendar.
  conflicts: [],
  sync: { pending: 0, lastResult: null, cursor: 0 },
  // The account's booking window as last reported by the server. Cached so the panel shows
  // real values offline rather than defaults it would invite the owner to overwrite.
  bookingPolicy: null,
  // The account's licence, as last reported by the server. Cached in the main process so an
  // offline device still knows what it may do.
  entitlements: null,
  // Tenancies, filtered from the same reservation list the rest of the app uses. Kept
  // separate so the page and its badge do not re-scan the list on every render.
  rentals: [],
};
