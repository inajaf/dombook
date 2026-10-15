const PAGE_META = {
  dashboard: { eyebrow: "Рабочий день", title: "Сегодня", action: "Новая бронь", actionType: "reservation", search: false },
  calendar: { eyebrow: "Доступность", title: "Календарь", action: "Новая бронь", actionType: "reservation", search: false },
  reservations: { eyebrow: "Гости и деньги", title: "Бронирования", action: "Новая бронь", actionType: "reservation", search: true },
  properties: { eyebrow: "Инвентарь", title: "Объекты", action: "Добавить объект", actionType: "property", search: true },
  rentals: { eyebrow: "Договоры", title: "Аренда", action: "Новый договор", actionType: "rental", search: true },
  conflicts: { eyebrow: "Целостность данных", title: "Конфликты", action: "Новая бронь", actionType: "reservation", search: false },
  settings: { eyebrow: "Надёжность", title: "Настройки", action: "Создать backup", actionType: "backup", search: false },
};

const STATUS_LABELS = {
  hold: "Холд",
  confirmed: "Подтверждена",
  checked_in: "Заехал",
  checked_out: "Выехал",
  cancelled: "Отменена",
  no_show: "Не заехал",
};

const DEPOSIT_LABELS = {
  none: "Не требуется",
  due: "Ожидается",
  received: "Получен",
  returned: "Возвращён",
  partially_withheld: "Частично удержан",
  withheld: "Удержан",
};

const state = {
  page: "dashboard",
  places: [],
  properties: [],
  reservations: [],
  dashboard: null,
  calendar: null,
  backups: [],
  systemInfo: null,
  // The price of the booking being edited, as computed by the main process. Null until the
  // dates and the unit are both chosen.
  quote: null,
  // Bumped per request so a slow quote cannot overwrite a newer one.
  quoteRequest: 0,
  // True once the owner types an amount: the computed figure stops replacing it.
  accommodationManual: false,
  // The booking the documents dialog is currently about.
  documentsReservation: null,
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

const api = window.domBook || createBrowserDemoApi();
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const interfaceLocale = () => window.i18n?.locale || "ru-RU";
const interfaceLanguage = () => window.i18n?.language || "ru";

/**
 * Interface text size.
 *
 * Everything in styles.css is sized from `--text-scale`, so this is the whole implementation of
 * "make it readable" — one number. It is a property of the SCREEN rather than of the business:
 * a 60-year-old owner on a laptop wants large type, the same account on a wall-mounted office
 * display does not, and neither should sync the other's preference. That is why it lives in
 * localStorage and not in app_settings, which the server replicates.
 */
const TEXT_SCALES = { normal: 1, large: 1.12, xlarge: 1.28 };
const TEXT_SCALE_KEY = "rentkeeper.interface-scale";

function textScaleName() {
  try {
    const stored = localStorage.getItem(TEXT_SCALE_KEY);
    return stored in TEXT_SCALES ? stored : "normal";
  } catch {
    // Storage can be unavailable; the default is the same as a first run.
    return "normal";
  }
}

function applyTextScale(name) {
  const resolved = name in TEXT_SCALES ? name : "normal";
  document.documentElement.style.setProperty("--text-scale", String(TEXT_SCALES[resolved]));
  try {
    localStorage.setItem(TEXT_SCALE_KEY, resolved);
  } catch {
    // A device that refuses storage still gets the size for this session.
  }
  return resolved;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function icon(id) {
  return `<svg aria-hidden="true"><use href="#${id}"></use></svg>`;
}

function money(minor, currency = "AZN") {
  return new Intl.NumberFormat(interfaceLocale(), {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(minor || 0) / 100);
}

function objectCountLabel(count) {
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

function guestCountLabel(count) {
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

function capacityLabel(count) {
  if (interfaceLanguage() === "en") return `up to ${guestCountLabel(count)}`;
  if (interfaceLanguage() === "az") return `maksimum ${guestCountLabel(count)}`;
  return `до ${Number(count || 0)} гостей`;
}

function bookingWindowHelp(fromDate, toDate) {
  if (interfaceLanguage() === "en") return `Check-in can be selected from ${longDate(fromDate)} to ${longDate(toDate)}.`;
  if (interfaceLanguage() === "az") return `Giriş ${longDate(fromDate)} tarixindən ${longDate(toDate)} tarixinədək seçilə bilər.`;
  return `Можно выбрать заезд с ${longDate(fromDate)} по ${longDate(toDate)}.`;
}

function maximumCheckoutHelp(date) {
  if (interfaceLanguage() === "en") return `For the selected check-in, checkout must be no later than ${longDate(date)}.`;
  if (interfaceLanguage() === "az") return `Seçilmiş giriş üçün çıxış ${longDate(date)} tarixindən gec olmamalıdır.`;
  return `Для выбранного заезда — не позже ${longDate(date)}.`;
}

function maximumStayHelp(months) {
  if (interfaceLanguage() === "en") return `Maximum stay is ${months} calendar months.`;
  if (interfaceLanguage() === "az") return `Maksimum qalma müddəti ${months} təqvim ayıdır.`;
  return `Проживание — максимум ${months} календарных месяца.`;
}

function balanceLabel(reservation) {
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

function shortDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(interfaceLocale(), { day: "2-digit", month: "short" })
    .format(new Date(`${value}T00:00:00`))
    .replace(".", "");
}

function longDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(interfaceLocale(), { day: "numeric", month: "long", year: "numeric" })
    .format(new Date(`${value}T00:00:00`));
}

function decimalToMinor(value) {
  return Math.round(Number(value || 0) * 100);
}

function minorToDecimal(value) {
  return (Number(value || 0) / 100).toFixed(2);
}

function addDaysIso(value, days = 1) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nightsBetween(checkInDate, checkOutDate) {
  if (!checkInDate || !checkOutDate) return 0;
  const checkIn = new Date(`${checkInDate}T00:00:00Z`);
  const checkOut = new Date(`${checkOutDate}T00:00:00Z`);
  const nights = Math.round((checkOut - checkIn) / 86_400_000);
  return Number.isFinite(nights) && nights > 0 ? nights : 0;
}

async function unwrap(promise) {
  const result = await promise;
  if (!result?.ok) throw new Error(result?.error || "Операция не выполнена");
  return result.data;
}

function toast(message, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type === "error" ? "error" : ""}`;
  element.textContent = message;
  $("#toastRegion").append(element);
  setTimeout(() => element.classList.add("is-leaving"), 3700);
  setTimeout(() => element.remove(), 3900);
}

function showError(target, error) {
  target.textContent = error.message || String(error);
  target.hidden = false;
  target.focus?.();
}

function setBusy(button, busy, text = "Сохранение…") {
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = text;
    button.disabled = true;
    button.classList.add("is-busy");
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

async function refreshCore() {
  const [places, properties, reservations, dashboard, calendar, systemInfo] = await Promise.all([
    unwrap(api.places.list({ includeArchived: true })),
    unwrap(api.properties.list({ includeArchived: true })),
    unwrap(api.reservations.list()),
    unwrap(api.dashboard.get()),
    unwrap(api.calendar.get(14)),
    unwrap(api.system.info()),
  ]);
  Object.assign(state, { places, properties, reservations, dashboard, calendar, systemInfo });
  window.i18n?.setLanguage(systemInfo.language || "ru");
  renderDashboard();
  renderCalendar();
  renderReservations();
  renderProperties();
  updateBadge();

  // Conflicted bookings are ordinary reservation rows, so the badge and the queue can be
  // derived from what was just loaded instead of issuing a second query. This keeps the
  // count correct from startup: an operator must not have to open the page to learn that
  // something needs attention.
  state.conflicts = reservations.filter((item) => item.status === "conflict");
  // Tenancies are reservations with a kind, so they are derived from the same load rather
  // than fetched separately: a second query could disagree with this list.
  state.rentals = reservations.filter((item) => item.booking_kind === "rental");
  updateConflictBadge();
  if (state.page === "rentals") renderRentals();
  if (state.page === "conflicts") renderConflicts();
  refreshSyncStatus().catch(() => {});
}

async function refreshSettings() {
  const [backups, systemInfo] = await Promise.all([
    unwrap(api.backups.list()),
    unwrap(api.system.info()),
  ]);
  Object.assign(state, { backups, systemInfo });
  renderSettings();
}

async function changeInterfaceLanguage(event) {
  const select = event.currentTarget;
  const language = select.value;
  select.disabled = true;
  try {
    const savedLanguage = await unwrap(api.system.setLanguage(language));
    state.systemInfo = { ...(state.systemInfo || {}), language: savedLanguage };
    window.i18n?.setLanguage(savedLanguage);
    renderDashboard();
    renderCalendar();
    renderReservations();
    renderProperties();
    renderSettings();
    navigate(state.page);
    window.i18n?.translateDom();
    toast(window.i18n?.t("Язык интерфейса изменён") || "Язык интерфейса изменён");
  } catch (error) {
    toast(error.message, "error");
    select.value = state.systemInfo?.language || "ru";
  } finally {
    select.disabled = false;
  }
}

function navigate(page) {
  if (!PAGE_META[page]) return;
  state.page = page;
  $$(".nav-item[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  $$(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
  const meta = PAGE_META[page];
  $("#pageEyebrow").textContent = meta.eyebrow;
  $("#pageTitle").textContent = meta.title;
  $("#primaryAction span").textContent = meta.action;
  $("#primaryAction").dataset.actionType = meta.actionType;
  const topbar = $(".topbar");
  topbar.classList.remove("is-changing");
  void topbar.offsetWidth;
  topbar.classList.add("is-changing");
  // The entrance animation is `fill-mode: both`, so the title and the primary action sit at
  // opacity 0 for as long as the animation is pending. A renderer that is not compositing —
  // an occluded or throttled window — never advances it, and the page title stays invisible.
  // Dropping the class when the motion has played makes the resting state the visible one.
  topbar.addEventListener("animationend", () => topbar.classList.remove("is-changing"), { once: true });
  setTimeout(() => topbar.classList.remove("is-changing"), 700);
  $("#searchBox").hidden = !meta.search;
  if (!meta.search) {
    state.search = "";
    $("#globalSearch").value = "";
  }
  if (page === "settings") {
    refreshSettings().catch((error) => toast(error.message, "error"));
    refreshSyncStatus().catch(() => {});
    refreshBookingPolicy().catch(() => {});
    refreshEntitlements().catch(() => {});
  }
  if (page === "conflicts") refreshConflicts().catch((error) => toast(error.message, "error"));
  if (page === "rentals") renderRentals();
  $("#main-content").focus({ preventScroll: true });
}

function renderDashboard() {
  const data = state.dashboard || {};
  $("#dashboardStats").innerHTML = [
    ["Активные дома", data.activeProperties || 0, "готовы к бронированию", ""],
    ["Активные брони", data.activeReservations || 0, "холд, подтверждено, заезд", ""],
    ["К получению", money(data.expectedMinor), "проживание и питание", "accent"],
    ["Залоги получены", money(data.depositsHeldMinor), "возвратные, не выручка", "accent"],
    ...(data.refundsDueMinor > 0 ? [["К возврату гостям", money(data.refundsDueMinor), "переплата после пересчёта", "warning"]] : []),
  ].map(([label, value, meta, className]) => `
    <article class="stat-card ${className}">
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <div class="stat-meta">${escapeHtml(meta)}</div>
    </article>
  `).join("");

  const operations = [
    ...(data.arrivals || []).map((item) => ({ ...item, type: "arrival", label: "Заезд", time: "15:00" })),
    ...(data.departures || []).map((item) => ({ ...item, type: "departure", label: "Выезд", time: "11:00" })),
  ];
  $("#todayOperations").innerHTML = operations.length
    ? `<div class="operation-list">${operations.map((item) => `
        <div class="operation-row">
          <span class="operation-time">${item.time}</span>
          <span><strong data-i18n-ignore>${escapeHtml(item.guest_name)}</strong><small><span data-i18n-ignore>${escapeHtml(item.place_name ? `${item.place_name} · ${item.property_name}` : item.property_name)}</span> · ${guestCountLabel(item.adults + item.children)}</small></span>
          <span class="operation-tag ${item.type}">${item.label}</span>
        </div>
      `).join("")}</div>`
    : `<div class="empty-inline">На сегодня заездов и выездов нет. Можно спокойно проверить будущие брони.</div>`;
}

function renderCalendar() {
  const data = state.calendar || { dates: [], properties: [], occupancy: [] };
  const maximumCheckInDate = state.systemInfo?.bookingPolicy?.maximumCheckInDate;
  const byKey = new Map(data.occupancy.map((item) => [`${item.property_id}:${item.night_date}`, item]));
  if (!data.properties.length) {
    $("#calendarContainer").innerHTML = `<div class="empty-state"><h3>Нет активных домов</h3><p>Добавьте или восстановите дом, чтобы увидеть календарь.</p></div>`;
    return;
  }
  const headers = data.dates.map((date) => {
    const parsed = new Date(`${date}T00:00:00`);
    const weekday = new Intl.DateTimeFormat(interfaceLocale(), { weekday: "short" }).format(parsed);
    return `<div class="calendar-cell calendar-head"><span><strong>${parsed.getDate()}</strong>${escapeHtml(weekday)}</span></div>`;
  }).join("");
  const rows = data.properties.map((property) => {
    const propertyContext = property.place_name || property.location || "Отдельный дом";
    return `
    <div class="calendar-cell calendar-house">
      <span class="calendar-house-copy">
        <strong class="calendar-house-name" data-i18n-ignore title="${escapeHtml(property.name)}">${escapeHtml(property.name)}</strong>
        <small class="calendar-house-context" ${property.place_name || property.location ? "data-i18n-ignore" : ""} title="${escapeHtml(propertyContext)}">${escapeHtml(propertyContext)}</small>
      </span>
    </div>
    ${data.dates.map((date) => {
      const booking = byKey.get(`${property.id}:${date}`);
      const outsideBookingWindow = !booking && maximumCheckInDate && date > maximumCheckInDate;
      const label = booking
        ? `Открыть бронь ${booking.guest_name} на ${longDate(date)}`
        : outsideBookingWindow
          ? `Новая бронь на ${longDate(date)} недоступна: максимум 21 день вперёд`
          : `Создать бронь для ${property.name} с ${longDate(date)}`;
      return `<button type="button" class="calendar-cell calendar-night ${booking ? "is-booked" : outsideBookingWindow ? "is-outside-window" : "is-free"}"
        data-calendar-property="${property.id}" data-calendar-date="${date}"
        ${booking ? `data-calendar-reservation="${booking.reservation_id}"` : ""}
        ${outsideBookingWindow ? "disabled" : ""}
        aria-label="${escapeHtml(label)}">${booking
        ? `<span class="calendar-booking ${booking.status}" data-i18n-ignore title="${escapeHtml(booking.guest_name)}">${escapeHtml(booking.guest_name)}</span>`
        : outsideBookingWindow
          ? `<span class="calendar-limit" aria-hidden="true">21+</span>`
          : `<span class="calendar-free" aria-hidden="true">+</span>`}</button>`;
    }).join("")}
  `;
  }).join("");
  // --calendar-days tells the grid how wide to be. Without it the grid squeezed its day
  // columns below their minimum and clipped the last one, half a date header and no way to
  // reach the rest.
  $("#calendarContainer").innerHTML = `<div class="calendar-scroll"><div class="calendar-grid" style="--calendar-days:${data.dates.length}"><div class="calendar-cell calendar-head calendar-house">Дом</div>${headers}${rows}</div></div>`;
}

function filteredReservations() {
  const query = state.search.toLocaleLowerCase("ru");
  return state.reservations.filter((reservation) => {
    const matchesSearch = !query || [reservation.guest_name, reservation.guest_phone, reservation.property_name]
      .some((value) => String(value || "").toLocaleLowerCase("ru").includes(query));
    if (!matchesSearch) return false;
    if (state.reservationFilter === "active") return ["hold", "confirmed", "checked_in"].includes(reservation.status);
    if (state.reservationFilter === "debt") return reservation.total_minor > reservation.prepaid_minor && !["cancelled", "no_show"].includes(reservation.status);
    if (state.reservationFilter === "deposit") return ["due", "received", "partially_withheld", "withheld"].includes(reservation.deposit_status);
    return true;
  });
}

function renderReservations() {
  const reservations = filteredReservations();
  const hasFilter = Boolean(state.search.trim()) || state.reservationFilter !== "all";
  $("#reservationTableBody").innerHTML = reservations.map((reservation) => `
    <tr>
      <td class="primary-cell"><strong data-i18n-ignore>${escapeHtml(reservation.guest_name)}</strong><small ${reservation.guest_phone || reservation.guest_email ? "data-i18n-ignore" : ""}>${escapeHtml(reservation.guest_phone || reservation.guest_email || "Контакт не указан")}</small></td>
      <td class="primary-cell reservation-property-cell"><strong data-i18n-ignore title="${escapeHtml(reservation.property_name)}">${escapeHtml(reservation.property_name)}</strong><small ${reservation.place_name ? "data-i18n-ignore" : ""}>${escapeHtml(reservation.place_name || "Отдельный дом")}</small></td>
      <td class="date-range"><span>${shortDate(reservation.check_in_date)} → ${shortDate(reservation.actual_check_out_date || reservation.check_out_date)}</span>${reservation.actual_check_out_date ? "<small>досрочно</small>" : ""}</td>
      <td><span class="status-badge status-${reservation.status}">${STATUS_LABELS[reservation.status]}</span></td>
      <td class="money-stack num"><strong>${money(reservation.prepaid_minor, reservation.currency)}</strong><small>${balanceLabel(reservation)}</small></td>
      <td class="money-stack num"><strong>${money(reservation.deposit_minor, reservation.currency)}</strong><small>${DEPOSIT_LABELS[reservation.deposit_status]}</small></td>
      <td><div class="row-actions">
        <button class="icon-button" data-edit-reservation="${reservation.id}" aria-label="Редактировать бронь ${escapeHtml(reservation.guest_name)}">${icon("i-edit")}</button>
        ${["hold", "confirmed", "checked_in"].includes(reservation.status) ? `<button class="button secondary row-text-action" data-early-checkout="${reservation.id}">Досрочный выезд</button>` : ""}
        <button class="icon-button" data-documents-reservation="${reservation.id}" aria-label="Документы по брони ${escapeHtml(reservation.guest_name)}">${icon("i-book")}</button>
        ${["cancelled", "checked_out", "no_show"].includes(reservation.status) ? "" : `<button class="icon-button danger" data-cancel-reservation="${reservation.id}" aria-label="Отменить бронь ${escapeHtml(reservation.guest_name)}">${icon("i-close")}</button>`}
        ${["cancelled", "checked_out", "no_show"].includes(reservation.status) ? `<button class="icon-button danger" data-delete-reservation="${reservation.id}" aria-label="Удалить бронь ${escapeHtml(reservation.guest_name)} навсегда">${icon("i-trash")}</button>` : ""}
      </div></td>
    </tr>
  `).join("");
  $("#reservationEmptyTitle").textContent = hasFilter ? "Бронирования не найдены" : "Бронирований пока нет";
  $("#reservationEmptyText").textContent = hasFilter
    ? "Измените поисковый запрос или выбранный фильтр."
    : "Создайте первую бронь — система проверит даты и рассчитает остаток.";
  $("#reservationEmptyAction").hidden = hasFilter;
  $("#reservationEmpty").hidden = reservations.length > 0;
  $(".table-scroll", $("#page-reservations")).hidden = reservations.length === 0;
}

function filteredProperties() {
  const showArchived = $("#showArchived").checked;
  const query = state.search.toLocaleLowerCase("ru");
  return state.properties.filter((property) => {
    if (!showArchived && property.status === "archived") return false;
    return !query || [property.name, property.location, property.place_name].some((value) => String(value || "").toLocaleLowerCase("ru").includes(query));
  });
}

/**
 * Render the rentals page.
 *
 * Tenancies are reservations with `booking_kind = "rental"`, so this reads the same list the
 * reservations page does and filters it. That is deliberate: a tenancy and a stay share one
 * availability calendar, and a second data source could disagree with it.
 */
function renderRentals() {
  const list = $("#rentalList");
  const rentals = state.rentals || [];

  const badge = $("#rentalBadge");
  if (badge) {
    badge.textContent = String(rentals.length);
    badge.hidden = rentals.length === 0;
  }

  if (rentals.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <strong>Договоров пока нет</strong>
        <p>Нажмите «Новый договор», чтобы сдать объект на месяц или дольше. Для этого у объекта
        должна быть указана цена за месяц.</p>
      </div>`;
    $("#rentalTotals").innerHTML = "";
    return;
  }

  // A small summary, because the first question about a portfolio of leases is what it is
  // worth and what is due.
  const rentTotal = rentals.reduce((sum, item) => sum + (item.accommodation_minor || 0), 0);
  const dueTotal = rentals.reduce((sum, item) => sum + Math.max((item.total_minor || 0) - (item.prepaid_minor || 0), 0), 0);
  const depositHeld = rentals.reduce((sum, item) => sum + (item.deposit_minor || 0), 0);
  $("#rentalTotals").innerHTML = `
    <div><span>Договоров</span><strong>${rentals.length}</strong></div>
    <div><span>Сумма аренды</span><strong>${money(rentTotal)}</strong></div>
    <div><span>Остаток к оплате</span><strong>${money(dueTotal)}</strong></div>
    <div><span>Депозиты</span><strong>${money(depositHeld)}</strong></div>`;

  list.innerHTML = rentals.map((rental) => {
    const unit = state.properties.find((item) => item.id === rental.property_id);
    // Precomputed by the main process, which owns the one implementation of the month
    // count. The renderer is sandboxed and cannot load modules, and a second copy of this
    // arithmetic here is exactly the drift the shared fixtures exist to prevent.
    const months = rental.rental_months || 0;
    const readings = readMeterReadings(rental.meter_readings);
    const readingsText = Object.entries(readings)
      .map(([name, value]) => `${escapeHtml(name)}: ${escapeHtml(String(value?.start ?? "—"))} → ${escapeHtml(String(value?.end ?? "—"))}`)
      .join(" · ");
    return `
      <article class="rental-card" data-rental="${escapeHtml(rental.id)}">
        <header>
          <div>
            <p class="eyebrow">${escapeHtml(reservationStatusLabel(rental.status))}</p>
            <h3 data-i18n-ignore>${escapeHtml(rental.guest_name)}</h3>
            <small data-i18n-ignore>${escapeHtml(unit?.name || "Объект удалён")}</small>
          </div>
          <span class="pill">${months} мес.</span>
        </header>
        <dl class="rental-terms">
          <div><dt>Срок</dt><dd data-i18n-ignore>${escapeHtml(longDate(rental.check_in_date))} — ${escapeHtml(longDate(rental.check_out_date))}</dd></div>
          <div><dt>Аренда</dt><dd>${money(rental.accommodation_minor)}</dd></div>
          <div><dt>Депозит</dt><dd>${money(rental.deposit_minor)}</dd></div>
          <div><dt>Остаток</dt><dd>${money(Math.max((rental.total_minor || 0) - (rental.prepaid_minor || 0), 0))}</dd></div>
        </dl>
        ${readingsText ? `<p class="muted rental-readings">Показания: <span data-i18n-ignore>${readingsText}</span></p>` : ""}
        <footer class="rental-actions">
          <button class="button secondary compact" data-edit-rental="${escapeHtml(rental.id)}">Изменить</button>
          <button class="button primary compact" data-contract-rental="${escapeHtml(rental.id)}">Договор PDF</button>
          <button class="button secondary compact" data-invoice-rental="${escapeHtml(rental.id)}">Счёт PDF</button>
        </footer>
      </article>`;
  }).join("");
}

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

function reservationStatusLabel(status) {
  return RESERVATION_STATUS_LABELS[status] || status || "";
}

/** Parse stored meter readings, tolerating anything unreadable. */
function readMeterReadings(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Reflect the booking kind in the dialog's hint text.
 *
 * The two kinds are judged by different limits — a tenancy is exempt from the advance window
 * and bounded by the month cap instead — so leaving the stay wording in place would tell the
 * user the wrong rule while they fill the form in.
 */
function applyKindToDialog(kind) {
  const isRental = kind === "rental";
  const policy = state.systemInfo?.bookingPolicy || {};
  const checkInHelp = $("#checkInDateHelp");
  const checkOutHelp = $("#checkOutDateHelp");
  if (checkInHelp) {
    checkInHelp.textContent = isRental
      ? "Для аренды ограничение по сроку подачи заявки не действует."
      : `Бронь доступна максимум на ${policy.maximumAdvanceDays ?? 21} день вперёд.`;
  }
  if (checkOutHelp) {
    checkOutHelp.textContent = isRental
      ? `Аренда — до ${policy.maximumTenancyMonths ?? 24} календарных месяцев.`
      : `Проживание — максимум ${policy.maximumStayMonths ?? 3} календарных месяца.`;
  }
  // Meals are a per-night service and are refused for a tenancy, so the section is hidden
  // rather than left visible and rejected on submit.
  const mealsSection = $("#mealSection") || document.querySelector("[data-meal-section]");
  if (mealsSection) mealsSection.hidden = isRental;
}

/** Open the reservation dialog as a rental. */
function openRentalDialog(rental = null) {
  // Rentals are reservations, so this is the ordinary dialog with the kind preset. A second
  // dialog would be a second place for validation to diverge.
  openReservationDialog(rental, { bookingKind: "rental" });
}

function renderProperties() {
  const properties = filteredProperties();
  const showArchived = $("#showArchived").checked;
  const query = state.search.toLocaleLowerCase("ru");
  const groups = [];
  state.places.forEach((place) => {
    if (!showArchived && place.status === "archived") return;
    const placeMatches = !query || [place.name, place.address]
      .some((value) => String(value || "").toLocaleLowerCase("ru").includes(query));
    const units = placeMatches
      ? state.properties.filter((property) => property.place_id === place.id && (showArchived || property.status === "active"))
      : properties.filter((property) => property.place_id === place.id);
    if (!query || placeMatches || units.length) {
      groups.push({ id: `place-${place.id}`, place, units });
    }
  });
  const standalone = properties.filter((property) => !property.place_id);
  if (standalone.length || !query) groups.push({ id: "standalone", place: null, units: standalone });

  const propertyCard = (property) => `
    <article class="property-card ${property.status}">
      <div class="property-visual">
        <span class="property-house-icon">${icon("i-house")}</span>
        <span class="property-status">${property.status === "active" ? "Активен" : "В архиве"}</span>
      </div>
      <div class="property-content">
        <div class="property-title-row">
          <div><h3 data-i18n-ignore>${escapeHtml(property.name)}</h3><p ${property.location || property.place_address ? "data-i18n-ignore" : ""}>${escapeHtml(property.location || property.place_address || "Расположение не указано")}</p><span class="property-kind">${property.kind === "cottage" ? "Коттедж" : "Отдельный дом"}</span></div>
          <div class="property-price">${money(property.base_price_minor, property.currency)}<small>за ночь</small></div>
        </div>
        <div class="property-meta">
          <div><small>Гостей</small><strong data-i18n-ignore>${escapeHtml(capacityLabel(property.capacity))}</strong></div>
          <div><small>Депозит</small><strong>${money(property.deposit_minor, property.currency)}</strong></div>
          <div><small>Брони</small><strong>${property.reservation_count}</strong></div>
        </div>
      </div>
      <footer class="property-actions">
        <button class="icon-button" data-edit-property="${property.id}" aria-label="Редактировать дом ${escapeHtml(property.name)}">${icon("i-edit")}</button>
        ${property.status === "active"
          ? `<button class="icon-button danger" data-archive-property="${property.id}" aria-label="Архивировать дом ${escapeHtml(property.name)}">${icon("i-archive")}</button>`
          : `<button class="icon-button" data-restore-property="${property.id}" aria-label="Восстановить дом ${escapeHtml(property.name)}">${icon("i-restore")}</button>`}
      </footer>
    </article>
  `;

  $("#propertyGroups").innerHTML = groups.map((group) => {
    const expanded = state.expandedGroups.has(group.id);
    const bodyId = `group-body-${group.id}`;
    return `
    <section class="property-group">
      <header class="property-group-header">
        <button type="button" class="property-group-toggle" data-toggle-group="${group.id}"
          aria-expanded="${expanded}" aria-controls="${bodyId}">
          <span>${icon("i-house")}</span>
          <div>
            <h3 ${group.place?.name ? "data-i18n-ignore" : ""}>${escapeHtml(group.place?.name || "Отдельные дома")}</h3>
            <p><span ${group.place?.address ? "data-i18n-ignore" : ""}>${escapeHtml(group.place?.address || "Сдаются самостоятельно")}</span> · ${objectCountLabel(group.units.length)}</p>
          </div>
          <span class="property-group-chevron">${icon("i-arrow")}</span>
        </button>
        ${group.place ? `<div class="property-group-actions">
          ${group.place.status === "active" ? `<button class="button secondary group-add-button" data-add-property-to-place="${group.place.id}">${icon("i-plus")}<span>Добавить коттедж</span></button>` : ""}
          <button class="icon-button" data-edit-place="${group.place.id}" aria-label="Редактировать дом отдыха ${escapeHtml(group.place.name)}">${icon("i-edit")}</button>
          ${group.place.status === "active"
            ? `<button class="icon-button danger" data-archive-place="${group.place.id}" aria-label="Архивировать дом отдыха ${escapeHtml(group.place.name)}">${icon("i-archive")}</button>`
            : `<button class="icon-button" data-restore-place="${group.place.id}" aria-label="Восстановить дом отдыха ${escapeHtml(group.place.name)}">${icon("i-restore")}</button>`}
        </div>` : `<div class="property-group-actions">
          <button class="button secondary group-add-button" data-add-standalone-house>${icon("i-plus")}<span>Добавить отдельный дом</span></button>
        </div>`}
      </header>
      <div class="property-group-body" id="${bodyId}" ${expanded ? "" : "hidden"}>
        <div class="property-grid">${group.units.map(propertyCard).join("")}</div>
        ${!group.units.length ? `<div class="empty-inline">В этом доме отдыха пока нет коттеджей. Нажмите «Добавить коттедж».</div>` : ""}
      </div>
    </section>
  `}).join("");
  $("#propertyEmpty").hidden = groups.length > 0;
}

/**
 * Render the conflict queue.
 *
 * Conflicted bookings live in the local database like everything else, so this page is
 * fully usable offline. That matters: the operator most likely to need it is the one whose
 * device has been offline.
 */
function renderConflicts() {
  const list = $("#conflictList");
  const conflicts = state.conflicts || [];

  if (conflicts.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <strong>Конфликтов нет</strong>
        <p>Все брони согласованы. Если устройство работало офлайн и его бронь столкнулась с занятыми датами, она появится здесь.</p>
      </div>`;
    return;
  }

  list.innerHTML = conflicts.map((conflict) => {
    const dates = Array.isArray(conflict.conflict_details?.dates) ? conflict.conflict_details.dates : [];
    const unit = state.properties.find((item) => item.id === conflict.unit_id);
    return `
      <article class="conflict-card" data-conflict="${escapeHtml(conflict.id)}">
        <header>
          <div>
            <p class="eyebrow">${escapeHtml(conflict.conflict_code || "conflict")}</p>
            <h3 data-i18n-ignore>${escapeHtml(conflict.guest_name || "Без имени")}</h3>
            <small data-i18n-ignore>${escapeHtml(unit?.name || "Объект удалён")}</small>
          </div>
          <span class="pill danger">Требует решения</span>
        </header>
        <dl class="conflict-dates">
          <div><dt>Заезд</dt><dd>${escapeHtml(conflict.check_in_date)}</dd></div>
          <div><dt>Выезд</dt><dd>${escapeHtml(conflict.check_out_date)}</dd></div>
        </dl>
        <p class="muted">
          ${dates.length
            ? `Занятые даты: <span data-i18n-ignore>${escapeHtml(dates.join(", "))}</span>`
            : "Даты пересекаются с уже существующей бронью."}
        </p>
        <footer class="conflict-actions">
          <button class="button secondary compact" data-conflict-action="reschedule" data-id="${escapeHtml(conflict.id)}">
            Перенести даты
          </button>
          <button class="button danger compact" data-conflict-action="cancel" data-id="${escapeHtml(conflict.id)}">
            Отменить бронь
          </button>
        </footer>
      </article>`;
  }).join("");
}

/** Reload the conflict queue from the local database. */
async function refreshConflicts() {
  const reservations = await window.domBook.reservations.list();
  if (!reservations.ok) {
    toast(reservations.error || "Не удалось загрузить конфликты", "error");
    return;
  }
  state.conflicts = (reservations.data || []).filter((item) => item.status === "conflict");
  renderConflicts();
  updateConflictBadge();
}

/** Show how many bookings need a decision. */
function updateConflictBadge() {
  const badge = $("#conflictBadge");
  if (!badge) return;
  const count = (state.conflicts || []).length;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

/**
 * Resolve a conflict.
 *
 * Both actions release the conflicting booking's claim on the dates. "Reschedule" opens the
 * ordinary reservation editor, so moving the guest is the same flow as editing any booking
 * rather than a separate mechanism that could behave differently.
 */
async function resolveConflict(reservationId, action) {
  const conflict = (state.conflicts || []).find((item) => item.id === reservationId);
  if (!conflict) return;

  if (action === "reschedule") {
    // Hand off to the existing editor: the operator picks free dates there, which is the
    // same validation every other booking goes through.
    navigate("reservations");
    openReservationDialog(conflict);
    toast("Выберите свободные даты и сохраните бронь");
    return;
  }

  // Cancelling frees the dates, which is what resolves the collision. The booking is kept
  // with a cancelled status, so the record of what happened survives.
  const response = await window.domBook.reservations.cancel(reservationId);
  if (!response.ok) {
    toast(response.error || "Не удалось отменить бронь", "error");
    return;
  }
  toast("Бронь отменена, даты освобождены");
  await refreshCore();
  await refreshConflicts();
}

/**
 * Render the booking-policy panel.
 *
 * The values shown are the CACHED ones when the server is unreachable, with a note saying
 * so. A form that silently showed defaults while the account had a different window would
 * invite the owner to "save" values that quietly changed their configuration.
 */
function renderPolicy() {
  const policy = state.bookingPolicy;
  if (!policy) return;

  $("#policyAdvance").value = policy.maximumAdvanceDays ?? "";
  $("#policyStay").value = policy.maximumStayMonths ?? "";
  $("#policyTimeZone").value = policy.timeZone ?? "";

  const badge = $("#policyBadge");
  if (policy.stale) {
    badge.textContent = "Сохранено локально";
    badge.className = "health-badge warn";
  } else if (policy.isDefault) {
    badge.textContent = "По умолчанию";
    badge.className = "health-badge";
  } else {
    badge.textContent = "Настроено";
    badge.className = "health-badge";
  }
}

/** Load the account's booking window, falling back to the cached copy when offline. */
async function refreshBookingPolicy() {
  const response = await window.domBook.bookingPolicy.get();
  if (!response.ok) return;
  state.bookingPolicy = response.data || null;
  renderPolicy();
}

/** Save a policy change. */
async function saveBookingPolicy(event) {
  event.preventDefault();
  const errorBox = $("#policyError");
  errorBox.hidden = true;

  const payload = {
    maximumAdvanceDays: Number($("#policyAdvance").value),
    maximumStayMonths: Number($("#policyStay").value),
    timeZone: $("#policyTimeZone").value.trim(),
  };

  const response = await window.domBook.bookingPolicy.set(payload);
  if (!response.ok) {
    errorBox.textContent = response.error || "Не удалось сохранить политику";
    errorBox.hidden = false;
    return;
  }
  state.bookingPolicy = response.data || payload;
  renderPolicy();
  toast("Политика бронирования сохранена");
}

/**
 * Render the licence panel.
 *
 * The panel states what the account has rather than nagging: a licensed customer sees the
 * licence they bought, and a free customer sees what the free tier includes. Only when the
 * account is actually over its allowance does the UI suggest buying — an upgrade prompt
 * shown to someone who already paid is the fastest way to make them doubt the purchase.
 */
function renderEntitlements() {
  const info = state.entitlements;
  if (!info) return;

  const badge = $("#licenseBadge");
  if (info.paid) {
    badge.textContent = "Лицензия активна";
    badge.className = "health-badge";
  } else {
    badge.textContent = "Бесплатная версия";
    badge.className = "health-badge warn";
  }

  const rows = [];
  rows.push(`<div><dt>Тариф</dt><dd>${escapeHtml(info.planName || (info.paid ? "Платный" : "Бесплатный"))}</dd></div>`);

  if (info.paid) {
    // A perpetual licence has no date, and saying so is the point of the one-time purchase.
    rows.push(`<div><dt>Срок</dt><dd>${info.expiresAt ? `до ${new Date(info.expiresAt).toLocaleDateString(interfaceLocale())}` : "бессрочно"}</dd></div>`);
    if (info.expiresAt) {
      rows.push(`<div><dt>Продление</dt><dd>требуется</dd></div>`);
    }
  }

  const allowance = info.allowance || {};
  if (allowance.unlimited) {
    rows.push(`<div><dt>Объекты</dt><dd>без ограничений</dd></div>`);
  } else {
    rows.push(`<div><dt>Объекты</dt><dd>${allowance.active ?? 0} из ${allowance.allowance ?? 1}</dd></div>`);
  }
  if (info.stale) {
    // Saying the value is cached is honest, and it explains why a licence bought on another
    // device has not appeared yet.
    rows.push(`<div><dt>Состояние</dt><dd>данные с последней синхронизации</dd></div>`);
  }
  $("#licenseInfo").innerHTML = rows.join("");

  // Only a free account that has run out of room is invited to buy. Showing the upsell to
  // someone who already paid is the fastest way to make them doubt the purchase.
  const overLimit = !allowance.unlimited && allowance.over;
  $("#licenseUpsell").hidden = !overLimit;
  $("#buyLicense").disabled = false;
}

/**
 * Explain how to obtain a licence.
 *
 * There is deliberately no checkout call here. The Go server has no payment endpoint yet:
 * entitents are granted by an operator or by a future webhook, and the desktop cannot create
 * one. Wiring the button to the legacy `/auth/checkout` route would open a page for a
 * subscription the new server does not sell, and the customer would pay for something that
 * never activates — the worst possible failure for a purchase flow.
 *
 * So the button is present, disabled, and honest about why. It becomes a real checkout once
 * the webhook endpoint exists; until then, a visible explanation beats a dead button or a
 * fake one.
 */
async function purchaseLicense() {
  toast("Онлайн-оплата ещё не подключена. Напишите нам, чтобы получить лицензию.");
}

/** Load the account's licence, falling back to the cached copy. *//** Load the account's licence, falling back to the cached copy. */
async function refreshEntitlements() {
  const response = await window.domBook.entitlements.get();
  if (!response.ok) return;
  state.entitlements = response.data || null;
  renderEntitlements();
}

/** Render the sync panel in settings. */
function renderSyncStatus() {
  const info = state.sync || { pending: 0, lastResult: null, cursor: 0 };
  const badge = $("#syncBadge");
  const rows = [];

  if (info.pending > 0) {
    badge.textContent = `${info.pending} к отправке`;
    badge.className = "health-badge warn";
  } else if (info.lastResult && info.lastResult.ok === false) {
    badge.textContent = "Ошибка";
    badge.className = "health-badge danger";
  } else if (info.cursor > 0) {
    badge.textContent = "Синхронизировано";
    badge.className = "health-badge";
  } else {
    badge.textContent = "Не синхронизировано";
    badge.className = "health-badge warn";
  }

  rows.push(`<div><dt>Локальные изменения</dt><dd>${info.pending > 0 ? `${info.pending} ждут отправки` : "все отправлены"}</dd></div>`);
  rows.push(`<div><dt>Курсор</dt><dd>${info.cursor || 0}</dd></div>`);
  if (info.lastResult?.at) {
    // The time is shown because "when did this last work" is the first question a user
    // asks about a sync that is not doing what they expect.
    rows.push(`<div><dt>Последняя попытка</dt><dd>${new Date(info.lastResult.at).toLocaleString(interfaceLocale())}</dd></div>`);
  }
  if (info.lastResult?.ok === false && info.lastResult.error) {
    rows.push(`<div><dt>Ошибка</dt><dd data-i18n-ignore>${escapeHtml(info.lastResult.error)}</dd></div>`);
  }
  const conflicts = (state.conflicts || []).length;
  if (conflicts > 0) {
    rows.push(`<div><dt>Конфликты</dt><dd>${conflicts} ждут решения</dd></div>`);
  }
  $("#syncInfo").innerHTML = rows.join("");
}

/** Ask the main process to sync now, then refresh what the UI shows. */
async function syncNow() {
  const response = await window.domBook.sync.now();
  if (!response.ok) {
    toast(response.error || "Синхронизация недоступна", "error");
    return;
  }
  const result = response.data || {};
  if (result.ok === false) {
    toast(result.error || "Не удалось синхронизировать", "error");
  } else if (result.skipped) {
    toast("Синхронизация уже выполняется");
  } else if (result.conflicts > 0) {
    toast(`Синхронизировано. Конфликтов: ${result.conflicts}`, "error");
  } else {
    toast(`Синхронизировано: отправлено ${result.pushed || 0}, получено ${result.applied || 0}`);
  }
  await refreshSyncStatus();
  await refreshCore();
  await refreshConflicts();
}

/** Read the current sync state from the main process. */
async function refreshSyncStatus() {
  const response = await window.domBook.sync.status();
  if (response.ok) state.sync = response.data || state.sync;
  renderSyncStatus();
}

/**
 * The documents dialog for one booking.
 *
 * A dialog rather than another icon on the row: a contract and an invoice are different documents
 * for different readers, and a tooltip is not enough to say which is which.
 */
function openDocumentsDialog(reservationId) {
  const reservation = state.reservations.find((item) => item.id === reservationId);
  if (!reservation) return;
  const isRental = reservation.booking_kind === "rental";
  state.documentsReservation = reservationId;
  $("#documentsDialogTitle").textContent = `Документы: ${reservation.guest_name}`;
  $("#documentsError").hidden = true;
  $("#documentsIntro").textContent = isRental
    ? "Договор найма — для подписания, счёт и акт — для бухгалтерии и налоговой. Файлы сохраняются в папку документов приложения."
    : "Для посуточной брони договор найма не нужен, но счёт и акт по ней — тот документ, который просят для отчётности.";
  // The contract is offered for a tenancy only: printing a "договор найма" for two nights would
  // produce a document with a monthly rent and a term that do not exist.
  $("#documentContract").hidden = !isRental;
  $("#documentsDialog").showModal();
}

async function createDocument(reservationId, kind) {
  const choose = $("#documentsChoosePath")?.checked === true;
  const result = await unwrap(api.documents.create({ reservationId, kind, choose }));
  if (result?.canceled) return;
  toast(`Документ сохранён: ${result.fileName}`);
  return result;
}

function renderSettings() {
  const info = state.systemInfo || {};
  $("#interfaceLanguage").value = info.language || window.i18n?.language || "ru";
  const textScale = $("#textScale");
  if (textScale) textScale.value = textScaleName();
  renderRequisites();
  $("#systemInfo").innerHTML = `
    <div><dt>Файл базы</dt><dd data-i18n-ignore>${escapeHtml(privateStorageLabel(info.databasePath, "dombook.sqlite"))}</dd></div>
    <div><dt>Размер</dt><dd>${formatBytes(info.databaseSize || 0)}</dd></div>
    <div><dt>Папка копий</dt><dd data-i18n-ignore>${escapeHtml(privateStorageLabel(info.backupDir, "backups"))}</dd></div>
  `;
  $("#backupList").innerHTML = state.backups.length ? state.backups.slice(0, 8).map((backup) => `
    <div class="backup-row">
      <span>${icon("i-database")}</span>
      <span><strong data-i18n-ignore>${escapeHtml(backup.file)}</strong><small>${new Date(backup.createdAt).toLocaleString(interfaceLocale())}</small></span>
      <small>${formatBytes(backup.size)}</small>
    </div>
  `).join("") : `<div class="empty-inline">Копий пока нет. Создайте первую перед внесением реальных данных.</div>`;
}

/** The details a contract prints, kept in app_settings so they follow the owner between devices. */
function renderRequisites() {
  const form = $("#requisitesForm");
  if (!form) return;
  const requisites = state.systemInfo?.documentRequisites || {};
  Object.entries(requisites).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value || "";
  });
}

async function submitRequisites(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("#requisitesError");
  errorBox.hidden = true;
  const payload = Object.fromEntries(
    ["lessorName", "lessorTaxId", "lessorAddress", "lessorPhone", "bankDetails", "signatoryName", "documentCity"]
      .map((key) => [key, form.elements[key]?.value ?? ""]),
  );
  const submit = $("#requisitesSubmit");
  try {
    setBusy(submit, true);
    const saved = await unwrap(api.system.setDocumentRequisites(payload));
    state.systemInfo = { ...(state.systemInfo || {}), documentRequisites: saved };
    toast("Реквизиты сохранены");
  } catch (error) {
    showError(errorBox, error);
  } finally {
    setBusy(submit, false);
  }
}

function privateStorageLabel(value, fallback) {
  if (!value) return fallback;
  if (value === "Browser local storage" || value === "Browser downloads") return value;
  const segments = String(value).split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || fallback;
}

function formatBytes(bytes) {
  const units = interfaceLanguage() === "ru" ? ["Б", "КБ", "МБ"] : ["B", "KB", "MB"];
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} ${units[1]}`;
  return `${(bytes / 1_048_576).toFixed(1)} ${units[2]}`;
}

function updateBadge() {
  const count = state.reservations.filter((item) => ["hold", "confirmed", "checked_in"].includes(item.status)).length;
  $("#reservationBadge").textContent = count;
  $("#reservationBadge").hidden = count === 0;
}

function openPropertyDialog(property = null, defaults = {}) {
  const form = $("#propertyForm");
  form.reset();
  $("#propertyFormError").hidden = true;
  $("#propertyPlace").innerHTML = `<option value="">Отдельный объект</option>${state.places
    .filter((place) => place.status === "active" || place.id === property?.place_id)
    .map((place) => `<option value="${place.id}">${escapeHtml(place.name)}</option>`).join("")}`;
  form.elements.id.value = property?.id || "";
  form.elements.kind.value = property?.kind || defaults.kind || (state.places.some((place) => place.status === "active") ? "cottage" : "house");
  form.elements.placeId.value = property?.place_id || defaults.placeId || "";
  form.elements.name.value = property?.name || "";
  form.elements.location.value = property?.location || "";
  form.elements.capacity.value = property?.capacity || 4;
  form.elements.currency.value = property?.currency || "AZN";
  form.elements.basePrice.value = minorToDecimal(property?.base_price_minor);
  // The monthly rate was never loaded, so opening a unit for editing showed 0 and saving wrote
  // that 0 back — which takes the unit off the rentals screen, because a zero monthly rate is how
  // the product says "not offered for rent". A dialog that clears a field it did not show is
  // data loss with no error.
  form.elements.monthlyRate.value = minorToDecimal(property?.monthly_rate_minor);
  form.elements.deposit.value = minorToDecimal(property?.deposit_minor);
  form.elements.checkInTime.value = property?.check_in_time || "15:00";
  form.elements.checkOutTime.value = property?.check_out_time || "11:00";
  form.elements.notes.value = property?.notes || "";
  renderRateRuleRows(property?.rate_rules);
  $("#propertyDialogTitle").textContent = property ? "Редактировать дом" : "Новый дом";
  $("#propertySubmit").textContent = property ? "Сохранить изменения" : "Создать дом";
  $("#propertyDialog").showModal();
  setTimeout(() => form.elements.name.focus(), 50);
}

function openPlaceDialog(place = null) {
  const form = $("#placeForm");
  form.reset();
  $("#placeFormError").hidden = true;
  form.elements.id.value = place?.id || "";
  form.elements.name.value = place?.name || "";
  form.elements.address.value = place?.address || "";
  form.elements.hasFoodService.checked = Boolean(place?.has_food_service);
  form.elements.notes.value = place?.notes || "";
  $("#placeDialogTitle").textContent = place ? "Редактировать дом отдыха" : "Новый дом отдыха";
  $("#placeSubmit").textContent = place ? "Сохранить изменения" : "Создать дом отдыха";
  $("#placeDialog").showModal();
  setTimeout(() => form.elements.name.focus(), 50);
}

function activeProperties() {
  return state.properties.filter((property) => property.status === "active");
}

function addCalendarMonthsIso(value, months) {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function updateReservationDateLimits() {
  const form = $("#reservationForm");
  const policy = state.systemInfo?.bookingPolicy;
  if (!policy) return;
  const checkIn = form.elements.checkInDate;
  const checkOut = form.elements.checkOutDate;
  const isNew = !form.elements.id.value;
  const checkInChanged = isNew || checkIn.value !== form.dataset.originalCheckIn;
  const datesChanged = checkInChanged || isNew || checkOut.value !== form.dataset.originalCheckOut;

  // A tenancy is judged by different rules, and the DATE INPUTS must reflect that or the
  // browser's own validation blocks the form before any of our checks run: a `max` of
  // today + 21 days makes a lease a year out an invalid field, and submit() silently does
  // nothing. So the bounds are computed per kind rather than once.
  const isRental = form.elements.bookingKind?.value === "rental";
  const maximumStayMonths = isRental
    ? (policy.maximumTenancyMonths ?? 24)
    : (policy.maximumStayMonths ?? 3);
  // The advance window does not apply to a tenancy, so its upper bound is open.
  const maximumCheckInDate = isRental ? "" : policy.maximumCheckInDate;
  const checkInWithinWindow = isRental
    ? Boolean(checkIn.value) && checkIn.value >= policy.today
    : Boolean(checkIn.value) && checkIn.value >= policy.today && checkIn.value <= policy.maximumCheckInDate;
  const maximumCheckOutDate = checkIn.value && checkInWithinWindow
    ? addCalendarMonthsIso(checkIn.value, maximumStayMonths)
    : "";

  checkIn.min = checkInChanged ? policy.today : "";
  checkIn.max = checkInChanged ? maximumCheckInDate : "";
  checkOut.min = datesChanged && checkIn.value ? addDaysIso(checkIn.value) : "";
  checkOut.max = datesChanged ? maximumCheckOutDate : "";

  let checkInError = "";
  let checkOutError = "";
  if (checkInChanged && checkIn.value < policy.today) {
    checkInError = "Дата заезда не может быть в прошлом";
  } else if (checkInChanged && !isRental && checkIn.value > policy.maximumCheckInDate) {
    checkInError = interfaceLanguage() === "en"
      ? `Check-in is available only through ${longDate(policy.maximumCheckInDate)}`
      : interfaceLanguage() === "az"
        ? `Giriş yalnız ${longDate(policy.maximumCheckInDate)} tarixinədək mümkündür`
        : `Заезд доступен максимум до ${longDate(policy.maximumCheckInDate)}`;
  }
  if (datesChanged && checkInWithinWindow && checkOut.value && checkOut.value <= checkIn.value) {
    checkOutError = "Дата выезда должна быть позже даты заезда";
  } else if (datesChanged && checkInWithinWindow && maximumCheckOutDate && checkOut.value > maximumCheckOutDate) {
    checkOutError = interfaceLanguage() === "en"
      ? `Checkout must be no later than ${longDate(maximumCheckOutDate)}`
      : interfaceLanguage() === "az"
        ? `Çıxış ${longDate(maximumCheckOutDate)} tarixindən gec olmamalıdır`
        : `Выезд должен быть не позже ${longDate(maximumCheckOutDate)}`;
  }
  checkIn.setCustomValidity(checkInError);
  checkOut.setCustomValidity(checkOutError);

  const checkInHelp = $("#checkInDateHelp");
  const checkOutHelp = $("#checkOutDateHelp");
  checkInHelp.textContent = checkInError || (isRental
    ? "Для аренды ограничение по сроку подачи заявки не действует."
    : bookingWindowHelp(policy.today, policy.maximumCheckInDate));
  checkOutHelp.textContent = checkOutError || (maximumCheckOutDate
    ? (isRental
      ? `Аренда — до ${maximumStayMonths} календарных месяцев.`
      : maximumCheckoutHelp(maximumCheckOutDate))
    : checkInError
      ? "Сначала выберите допустимую дату заезда."
      : (isRental
        ? `Аренда — до ${maximumStayMonths} календарных месяцев.`
        : maximumStayHelp(policy.maximumStayMonths)));
  checkInHelp.classList.toggle("limit-error", Boolean(checkInError));
  checkOutHelp.classList.toggle("limit-error", Boolean(checkOutError));
}

function openReservationDialog(reservation = null, defaults = {}) {
  const houses = activeProperties();
  if (!houses.length) {
    toast("Сначала добавьте активный дом", "error");
    navigate("properties");
    return;
  }
  const form = $("#reservationForm");
  form.reset();
  $("#reservationFormError").hidden = true;

  // The kind decides which units can be chosen. A tenancy needs a monthly rate: offering a
  // unit without one would let the user fill in a whole form and only then be told the let
  // cannot be priced.
  const kind = reservation?.booking_kind === "rental" || defaults.bookingKind === "rental" ? "rental" : "stay";
  form.elements.bookingKind.value = kind;
  const eligible = kind === "rental"
    ? houses.filter((property) => (property.monthly_rate_minor || 0) > 0)
    : houses;
  if (kind === "rental" && eligible.length === 0) {
    toast("Ни у одного объекта не указана цена за месяц", "error");
    navigate("properties");
    return;
  }
  $("#reservationProperty").innerHTML = eligible.map((property) =>
    `<option value="${property.id}">${escapeHtml(property.place_name ? `${property.place_name} — ${property.name}` : property.name)} · ${escapeHtml(capacityLabel(property.capacity))}</option>`
  ).join("");
  applyKindToDialog(kind);
  const today = state.systemInfo?.bookingPolicy?.today || new Date().toISOString().slice(0, 10);
  const tomorrow = addDaysIso(today);
  const afterTomorrow = addDaysIso(today, 2);
  form.elements.id.value = reservation?.id || "";
  // The default unit comes from the ELIGIBLE list, not the full one. Using houses[0] would
  // assign a unit that is not an option for a tenancy, and assigning an unknown value to a
  // <select> silently leaves it unselected — which, on a required field, makes submit do
  // nothing at all with no error shown.
  form.elements.propertyId.value = reservation?.property_id || defaults.propertyId || eligible[0].id;
  form.elements.checkInDate.value = reservation?.check_in_date || defaults.checkInDate || tomorrow;
  form.elements.checkOutDate.value = reservation?.check_out_date || defaults.checkOutDate || afterTomorrow;
  form.dataset.originalCheckIn = reservation?.check_in_date || "";
  form.dataset.originalCheckOut = reservation?.check_out_date || "";
  form.elements.guestName.value = reservation?.guest_name || "";
  form.elements.guestPhone.value = reservation?.guest_phone || "";
  form.elements.guestEmail.value = reservation?.guest_email || "";
  form.elements.adults.value = reservation?.adults || 2;
  form.elements.children.value = reservation?.children || 0;
  // A booking that already exists opens at the amount it was taken at, and is treated as
  // agreed: re-quoting it on open would reprice a live booking against today's seasons.
  state.accommodationManual = Boolean(reservation);
  state.quote = null;
  state.quoteRequest += 1;
  form.elements.accommodation.value = minorToDecimal(reservation?.accommodation_minor);
  form.elements.prepaid.value = minorToDecimal(reservation?.prepaid_minor);
  form.elements.status.value = reservation?.status || "hold";
  form.elements.notes.value = reservation?.notes || "";
  $("#reservationMealDays").innerHTML = "";
  updateReservationDateLimits();
  applyPropertyDefaults(reservation);
  renderMealInputs(reservation);
  if (reservation) {
    form.elements.deposit.value = minorToDecimal(reservation.deposit_minor);
    form.elements.depositStatus.value = reservation.deposit_status;
  }
  if (!reservation) recalculateReservationTotal();
  renderReservationCalculation();
  $("#reservationDialogTitle").textContent = reservation ? `Бронь №${reservation.id}` : "Новая бронь";
  $("#reservationSubmit").textContent = reservation ? "Сохранить изменения" : "Создать бронь";
  $("#reservationDialog").showModal();
  setTimeout(() => form.elements.propertyId.focus(), 50);
}

function applyPropertyDefaults(existingReservation = null) {
  const form = $("#reservationForm");
  const property = state.properties.find((item) => item.id === form.elements.propertyId.value);
  if (!property || existingReservation) return;
  form.elements.deposit.value = minorToDecimal(property.deposit_minor);
  form.elements.depositStatus.value = property.deposit_minor > 0 ? "due" : "none";
}

function selectedPlace() {
  const form = $("#reservationForm");
  const property = state.properties.find((item) => item.id === form.elements.propertyId.value);
  return state.places.find((item) => item.id === property?.place_id) || null;
}

function mealDateLabel(value) {
  return new Intl.DateTimeFormat(interfaceLocale(), { weekday: "short", day: "numeric", month: "long" })
    .format(new Date(`${value}T00:00:00`));
}

function currentMealDraft() {
  return new Map($$("[data-meal-amount]", $("#reservationMealDays")).map((input) => [
    `${input.dataset.mealDate}:${input.dataset.mealType}`,
    input.value,
  ]));
}

function reservationMealDates() {
  const form = $("#reservationForm");
  const reservation = state.reservations.find((item) => item.id === form.elements.id.value);
  const checkIn = form.elements.checkInDate.value;
  const plannedCheckOut = form.elements.checkOutDate.value;
  if (!form.elements.checkInDate.validity.valid || !form.elements.checkOutDate.validity.valid) return [];
  const checkOut = reservation?.actual_check_out_date || plannedCheckOut;
  if (!checkIn || !checkOut || nightsBetween(checkIn, checkOut) < 1) return [];
  const dates = [];
  for (let cursor = checkIn; cursor < checkOut && dates.length < 730; cursor = addDaysIso(cursor)) {
    dates.push(cursor);
  }
  return dates;
}

/**
 * Number the booking form's sections 1, 2, 3 … as they are actually shown.
 *
 * The numbers are printed in the markup, and the food section is hidden for a place with no
 * kitchen. An owner filling the form then read "1 Дом и даты, 2 Гость, 4 Деньги и статус" and
 * had to work out that they had not skipped anything. The number is a position, so it has to be
 * computed from what is on screen rather than typed into the markup.
 */
function renumberReservationSections() {
  let shown = 0;
  $$(".form-section", $("#reservationForm")).forEach((section) => {
    if (section.hidden) return;
    shown += 1;
    const marker = $("h3 span", section);
    if (marker) marker.textContent = String(shown);
  });
}

function renderMealInputs(reservation = null) {
  const place = selectedPlace();
  const section = $("#reservationFoodSection");
  const container = $("#reservationMealDays");
  const draft = currentMealDraft();
  (reservation?.meals || []).forEach((meal) => {
    draft.set(`${meal.meal_date}:${meal.meal_type}`, minorToDecimal(meal.amount_minor));
  });
  section.hidden = !place?.has_food_service;
  renumberReservationSections();
  if (!place?.has_food_service) {
    container.innerHTML = "";
    renderReservationCalculation();
    return;
  }
  const dates = reservationMealDates();
  if (!dates.length) {
    container.innerHTML = '<p class="meal-empty">Сначала выберите корректные даты заезда и выезда.</p>';
    renderReservationCalculation();
    return;
  }
  const mealTypes = [
    ["breakfast", "Завтрак"],
    ["lunch", "Обед"],
    ["dinner", "Ужин"],
  ];
  container.innerHTML = `<div class="meal-day-row meal-day-header" aria-hidden="true">
    <span>Дата</span><span>Завтрак</span><span>Обед</span><span>Ужин</span><span style="text-align:right">За день</span>
  </div>${dates.map((date) => `<div class="meal-day-row" data-meal-day="${date}">
    <div class="meal-date"><strong>${escapeHtml(mealDateLabel(date))}</strong><small>${date}</small></div>
    ${mealTypes.map(([type, label]) => `<label class="meal-amount"><span>${label}</span><div class="money-input">
      <input type="number" min="0" step="0.01" inputmode="decimal"
        value="${escapeHtml(draft.get(`${date}:${type}`) || "0.00")}"
        data-meal-amount data-meal-date="${date}" data-meal-type="${type}"
        aria-label="${label} за ${escapeHtml(mealDateLabel(date))}"><span>₼</span>
    </div></label>`).join("")}
    <output class="meal-day-total" data-meal-day-total="${date}">0 ₼</output>
  </div>`).join("")}`;
  $$("[data-meal-amount]", container).forEach((input) => input.addEventListener("input", renderReservationCalculation));
  renderReservationCalculation();
}

function renderReservationCalculation() {
  const form = $("#reservationForm");
  const property = state.properties.find((item) => item.id === form.elements.propertyId.value);
  const datesAreValid = form.elements.checkInDate.validity.valid && form.elements.checkOutDate.validity.valid;
  const nights = datesAreValid
    ? nightsBetween(form.elements.checkInDate.value, form.elements.checkOutDate.value)
    : 0;
  const accommodationMinor = decimalToMinor(form.elements.accommodation.value);
  const servicesMinor = $$("[data-meal-amount]", $("#reservationMealDays"))
    .reduce((sum, input) => sum + decimalToMinor(input.value), 0);
  $$("[data-meal-day]", $("#reservationMealDays")).forEach((row) => {
    const dayTotal = $$("[data-meal-amount]", row).reduce((sum, input) => sum + decimalToMinor(input.value), 0);
    $("[data-meal-day-total]", row).textContent = money(dayTotal, property?.currency);
  });
  const totalMinor = accommodationMinor + servicesMinor;
  const currency = property?.currency;
  const prepaidMinor = decimalToMinor(form.elements.prepaid.value);
  const depositMinor = decimalToMinor(form.elements.deposit.value);
  // The quote is the authority on how many nights are being sold, not the local date arithmetic:
  // a date outside the booking window fails HTML validation, which zeroed the local count while
  // the price beside it was still quoted for a real stay. Two numbers on one panel disagreeing
  // about the same booking is worse than either being wrong on its own.
  const quote = state.quote;
  $("#calculationNights").textContent = quote
    ? (quote.kind === "rental"
      ? `${quote.months} ${monthLabel(quote.months)}`
      : `${quote.nights} ${nightLabel(quote.nights)}`)
    : `${nights} ${nightLabel(nights)}`;
  $("#calculationFormula").textContent = quote && !state.accommodationManual
    ? formulaLabel(quote, property, currency)
    : "Выберите корректные даты";
  // One line per rate that applied, so a stay crossing a season boundary explains itself instead
  // of showing a total the owner has to reverse-engineer.
  $("#calculationLines").innerHTML = quote && !state.accommodationManual && quote.kind === "stay"
    ? quote.lines.filter((line) => line.label).map((line) => `
        <span>${escapeHtml(line.label)}: ${line.nights} × ${money(line.nightlyRateMinor, property?.currency)}</span>`).join("")
    : "";
  $("#calculationTotal").textContent = money(totalMinor, property?.currency);
  $("#calculationServices").textContent = money(servicesMinor, property?.currency);
  const discountMinor = quote && !state.accommodationManual ? quote.discountMinor : 0;
  $("#calculationDiscountRow").hidden = discountMinor <= 0;
  $("#calculationDiscount").textContent = discountMinor > 0
    ? `−${money(discountMinor, property?.currency)} (${quote.discountPercent}%)`
    : money(0, property?.currency);
  $("#resetAccommodation").hidden = !state.accommodationManual;
  $("#accommodationHelp").textContent = state.accommodationManual
    ? "Сумма указана вручную и заменяет расчёт."
    : "Считается автоматически: ночи, сезоны и скидка за длительность.";
  $("#calculationPrepaid").textContent = money(prepaidMinor, property?.currency);
  $("#calculationBalance").textContent = money(Math.max(0, totalMinor - prepaidMinor), property?.currency);
  $("#calculationDeposit").textContent = money(depositMinor, property?.currency);
}

/** The night count with the right Russian form, which the app already needed elsewhere. */
function nightLabel(count) {
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
function monthLabel(months) {
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
function formulaLabel(quote, property, currency) {
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
async function recalculateReservationTotal() {
  const form = $("#reservationForm");
  const propertyId = form.elements.propertyId.value;
  const checkInDate = form.elements.checkInDate.value;
  const checkOutDate = form.elements.checkOutDate.value;
  const bookingKind = form.elements.bookingKind?.value === "rental" ? "rental" : "stay";
  const requestId = state.quoteRequest + 1;
  state.quoteRequest = requestId;

  if (!propertyId || !checkInDate || !checkOutDate || checkOutDate <= checkInDate) {
    state.quote = null;
    if (!state.accommodationManual) form.elements.accommodation.value = "0.00";
    renderReservationCalculation();
    return;
  }

  try {
    const quote = await unwrap(api.pricing.quote({
      propertyId,
      bookingKind,
      checkInDate,
      checkOutDate,
      reservationId: form.elements.id.value || null,
    }));
    if (requestId !== state.quoteRequest) return;
    state.quote = quote;
    // A manual amount is the owner's decision for THIS booking and is not overwritten by a
    // recalculation — the whole point of typing one is that the rules do not apply.
    if (!state.accommodationManual) {
      form.elements.accommodation.value = minorToDecimal(quote.totalMinor);
    }
  } catch (error) {
    state.quote = null;
    if (!state.accommodationManual) form.elements.accommodation.value = "0.00";
    console.warn("Quote failed", error);
  }
  renderReservationCalculation();
}

/**
 * The seasons and discount rows of the unit dialog.
 *
 * A stored rule set is untrusted input as far as the view is concerned — it may come from another
 * device, or from a version of this app that stored a shape this one does not know. So the rows
 * are built from the fields that exist here and anything else is dropped, rather than a JSON
 * blob being handed to the user to edit.
 */
function renderRateRuleRows(rawRules) {
  let rules = {};
  try {
    rules = typeof rawRules === "string" ? JSON.parse(rawRules || "{}") : (rawRules || {});
    if (!rules || typeof rules !== "object") rules = {};
  } catch {
    // An unreadable value shows as "no rules", which is what the pricing module would do with it
    // anyway. Showing a parse error would block an edit that is about to replace the value.
    rules = {};
  }
  $("#stayDiscountRows").innerHTML = (Array.isArray(rules.stayDiscounts) ? rules.stayDiscounts : [])
    .map((entry) => discountRow("minimumNights", "ночей", entry)).join("");
  $("#tenancyDiscountRows").innerHTML = (Array.isArray(rules.tenancyDiscounts) ? rules.tenancyDiscounts : [])
    .map((entry) => discountRow("minimumMonths", "месяцев", entry)).join("");
  $("#seasonRows").innerHTML = (Array.isArray(rules.seasons) ? rules.seasons : [])
    .map((season) => `
      <div class="rule-row season-row" data-rule-row>
        <label class="field"><span>Название</span>
          <input data-rule-field="name" maxlength="80" value="${escapeHtml(season.name || "")}" placeholder="Новый год"></label>
        <label class="field"><span>Первая ночь</span>
          <input data-rule-field="from" type="date" value="${escapeHtml(season.from || "")}"></label>
        <label class="field"><span>Последняя ночь</span>
          <input data-rule-field="to" type="date" value="${escapeHtml(season.to || "")}"></label>
        <label class="field"><span>Цена за ночь</span>
          <div class="money-input"><input data-rule-field="nightlyRateMinor" type="number" min="0" step="0.01"
            value="${escapeHtml(minorToDecimal(season.nightlyRateMinor))}"><span>₼</span></div></label>
        <button type="button" class="icon-button danger" data-remove-rule aria-label="Удалить сезон">${icon("i-trash")}</button>
      </div>`).join("");
}

function discountRow(thresholdField, unitLabel, entry) {
  return `
    <div class="rule-row" data-rule-row>
      <label class="field"><span>От</span>
        <input data-rule-field="${thresholdField}" type="number" min="2" step="1" value="${Number(entry?.[thresholdField]) || ""}"></label>
      <span class="rule-unit">${unitLabel}</span>
      <label class="field"><span>Скидка</span>
        <input data-rule-field="percent" type="number" min="1" max="100" step="1" value="${Number(entry?.percent) || ""}"></label>
      <span class="rule-unit">%</span>
      <button type="button" class="icon-button danger" data-remove-rule aria-label="Удалить скидку">${icon("i-trash")}</button>
    </div>`;
}

/** Read the editor back into the shape the pricing module stores. */
function collectRateRules() {
  // Read row by row rather than zipping two filtered lists, which pairs the wrong threshold with
  // the wrong percentage as soon as one row is half-filled.
  const discounts = (root, field) => $$("[data-rule-row]", root).map((row) => ({
    [field]: Number($(`[data-rule-field="${field}"]`, row)?.value),
    percent: Number($(`[data-rule-field="percent"]`, row)?.value),
  })).filter((entry) => Number.isFinite(entry[field]) && entry[field] >= 2
    && Number.isFinite(entry.percent) && entry.percent > 0);

  const seasons = $$("[data-rule-row]", $("#seasonRows")).map((row) => ({
    name: $(`[data-rule-field="name"]`, row)?.value.trim() || "",
    from: $(`[data-rule-field="from"]`, row)?.value || "",
    to: $(`[data-rule-field="to"]`, row)?.value || "",
    nightlyRateMinor: decimalToMinor($(`[data-rule-field="nightlyRateMinor"]`, row)?.value || "0"),
  })).filter((season) => season.from || season.to || season.nightlyRateMinor > 0);

  return {
    version: 1,
    seasons,
    stayDiscounts: discounts($("#stayDiscountRows"), "minimumNights"),
    tenancyDiscounts: discounts($("#tenancyDiscountRows"), "minimumMonths"),
  };
}

async function submitProperty(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = $("#propertySubmit");
  const errorBox = $("#propertyFormError");
  errorBox.hidden = true;
  const payload = {
    placeId: form.elements.placeId.value || null,
    kind: form.elements.kind.value,
    name: form.elements.name.value,
    location: form.elements.location.value,
    capacity: Number(form.elements.capacity.value),
    currency: form.elements.currency.value,
    basePriceMinor: decimalToMinor(form.elements.basePrice.value),
    // 0 means "not offered for rent", which is how the Rentals page decides what to list.
    monthlyRateMinor: decimalToMinor(form.elements.monthlyRate.value),
    // The unit's seasons and length discounts. Sent as a structure and validated in the main
    // process, which owns the pricing rules — the renderer must not decide what is priceable.
    rateRules: collectRateRules(),
    depositMinor: decimalToMinor(form.elements.deposit.value),
    checkInTime: form.elements.checkInTime.value,
    checkOutTime: form.elements.checkOutTime.value,
    notes: form.elements.notes.value,
    status: state.properties.find((item) => item.id === form.elements.id.value)?.status || "active",
  };
  try {
    setBusy(submit, true);
    const id = form.elements.id.value;
    if (id) await unwrap(api.properties.update(id, payload));
    else await unwrap(api.properties.create(payload));
    $("#propertyDialog").close();
    await refreshCore();
    toast(id ? "Дом обновлён" : "Дом создан");
  } catch (error) {
    showError(errorBox, error);
  } finally {
    setBusy(submit, false);
  }
}

async function submitPlace(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = $("#placeSubmit");
  const errorBox = $("#placeFormError");
  errorBox.hidden = true;
  const id = form.elements.id.value;
  const current = state.places.find((place) => place.id === id);
  const payload = {
    name: form.elements.name.value,
    address: form.elements.address.value,
    hasFoodService: form.elements.hasFoodService.checked,
    notes: form.elements.notes.value,
    status: current?.status || "active",
  };
  try {
    setBusy(submit, true);
    if (id) {
      await unwrap(api.places.update(id, payload));
    } else {
      const created = await unwrap(api.places.create(payload));
      state.expandedGroups.add(`place-${created.id}`);
    }
    $("#placeDialog").close();
    await refreshCore();
    toast(id ? "Дом отдыха обновлён" : "Дом отдыха создан");
  } catch (error) {
    showError(errorBox, error);
  } finally {
    setBusy(submit, false);
  }
}

async function submitReservation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = $("#reservationSubmit");
  const errorBox = $("#reservationFormError");
  errorBox.hidden = true;
  const payload = {
    bookingKind: form.elements.bookingKind?.value === "rental" ? "rental" : "stay",
    propertyId: form.elements.propertyId.value,
    // Sent only when the owner typed an amount. The field always DISPLAYS the computed price, so
    // sending it unconditionally would turn every booking into a negotiated one and freeze the
    // figure against later rule changes — which is the opposite of what the rules are for.
    ...(state.accommodationManual
      ? { accommodationMinor: decimalToMinor(form.elements.accommodation.value) }
      : {}),
    checkInDate: form.elements.checkInDate.value,
    checkOutDate: form.elements.checkOutDate.value,
    guestName: form.elements.guestName.value,
    guestPhone: form.elements.guestPhone.value,
    guestEmail: form.elements.guestEmail.value,
    adults: Number(form.elements.adults.value),
    children: Number(form.elements.children.value),
    prepaidMinor: decimalToMinor(form.elements.prepaid.value),
    depositMinor: decimalToMinor(form.elements.deposit.value),
    depositStatus: form.elements.depositStatus.value,
    status: form.elements.status.value,
    notes: form.elements.notes.value,
    mealItems: $$("[data-meal-amount]", $("#reservationMealDays"))
      .map((input) => ({
        date: input.dataset.mealDate,
        type: input.dataset.mealType,
        amountMinor: decimalToMinor(input.value),
      }))
      .filter((item) => item.amountMinor > 0),
  };
  try {
    setBusy(submit, true);
    const id = form.elements.id.value;
    if (id) await unwrap(api.reservations.update(id, payload));
    else await unwrap(api.reservations.create(payload));
    $("#reservationDialog").close();
    await refreshCore();
    toast(id ? "Бронь обновлена" : "Бронь создана");
  } catch (error) {
    showError(errorBox, error);
  } finally {
    setBusy(submit, false);
  }
}

function togglePlaceFoodPrices() {
  // Цены вводятся вручную для каждого дня уже при создании брони.
}

function openEarlyCheckoutDialog(reservation) {
  const form = $("#earlyCheckoutForm");
  form.reset();
  $("#earlyCheckoutError").hidden = true;
  form.elements.id.value = reservation.id;
  form.elements.actualCheckOutDate.min = reservation.check_in_date;
  form.elements.actualCheckOutDate.max = addDaysIso(reservation.check_out_date, -1);
  form.elements.actualCheckOutDate.value = addDaysIso(reservation.check_in_date, 1);
  $("#earlyCheckoutDescription").textContent = `${reservation.guest_name} · ${reservation.property_name} · плановый выезд ${longDate(reservation.check_out_date)}. Питание за освобождаемые даты будет убрано из счёта.`;
  renderEarlyCheckoutPreview();
  $("#earlyCheckoutDialog").showModal();
}

function renderEarlyCheckoutPreview() {
  const form = $("#earlyCheckoutForm");
  const reservation = state.reservations.find((item) => item.id === form.elements.id.value);
  if (!reservation) return;
  const usedNights = nightsBetween(reservation.check_in_date, form.elements.actualCheckOutDate.value);
  const keepTotal = form.elements.billingPolicy.value === "keep_total";
  const accommodation = keepTotal ? reservation.accommodation_minor : reservation.nightly_rate_minor * usedNights;
  const services = (reservation.meals || [])
    .filter((meal) => meal.meal_date < form.elements.actualCheckOutDate.value)
    .reduce((sum, meal) => sum + Number(meal.amount_minor), 0);
  const total = accommodation + services;
  const due = Math.max(total - reservation.prepaid_minor, 0);
  const refund = Math.max(reservation.prepaid_minor - total, 0);
  $("#earlyCheckoutPreview").innerHTML = `<div class="calculation-heading">
    <span><small>Использовано</small><strong>${usedNights} ночей</strong></span>
    <span><small>Новая общая сумма</small><strong>${money(total, reservation.currency)}</strong></span>
  </div><div class="calculation-breakdown">
    <span><small>Проживание</small><strong>${money(accommodation, reservation.currency)}</strong></span>
    <span><small>Питание до выезда</small><strong>${money(services, reservation.currency)}</strong></span>
    <span><small>${refund ? "К возврату" : "Осталось получить"}</small><strong>${money(refund || due, reservation.currency)}</strong></span>
  </div>`;
}

async function submitEarlyCheckout(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = $("#earlyCheckoutSubmit");
  const errorBox = $("#earlyCheckoutError");
  errorBox.hidden = true;
  try {
    setBusy(button, true);
    await unwrap(api.reservations.earlyCheckout(form.elements.id.value, {
      actualCheckOutDate: form.elements.actualCheckOutDate.value,
      billingPolicy: form.elements.billingPolicy.value,
    }));
    $("#earlyCheckoutDialog").close();
    await refreshCore();
    toast("Досрочный выезд оформлен, будущие ночи свободны");
  } catch (error) {
    showError(errorBox, error);
  } finally {
    setBusy(button, false);
  }
}

function confirmAction({ title, text, button = "Подтвердить", action }) {
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmAction").textContent = button;
  const dialog = $("#confirmDialog");
  dialog.returnValue = "";
  dialog.showModal();
  dialog.addEventListener("close", async function onClose() {
    dialog.removeEventListener("close", onClose);
    if (dialog.returnValue !== "confirm") return;
    try {
      await action();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function createBackup() {
  const button = $("#createBackup");
  setBusy(button, true, "Создание…");
  try {
    await unwrap(api.backups.create());
    await refreshSettings();
    toast("Резервная копия создана");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  $$(".nav-item[data-page]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));

  $("#policyForm")?.addEventListener("submit", (event) => {
    saveBookingPolicy(event).catch((error) => toast(error.message, "error"));
  });
  $("#buyLicense")?.addEventListener("click", () => {
    purchaseLicense().catch((error) => toast(error.message, "error"));
  });
  $("#newRental")?.addEventListener("click", () => openRentalDialog());
  $("#reservationKind")?.addEventListener("change", (event) => {
    // Re-filter the unit list: a tenancy needs a unit with a monthly rate, so changing the
    // kind can change what is selectable.
    openReservationDialog(null, { bookingKind: event.target.value });
  });
  $("#syncNow")?.addEventListener("click", () => {
    syncNow().catch((error) => toast(error.message, "error"));
  });
  $("#refreshConflicts")?.addEventListener("click", () => {
    refreshConflicts().catch((error) => toast(error.message, "error"));
  });

  // The main process reports every sync attempt, so a failure becomes visible in the UI
  // rather than only in a log. Without this the indicator would only update when the user
  // pressed the button, and a background failure would go unnoticed.
  window.domBook?.sync?.onChanged?.((syncState) => {
    state.sync = {
      pending: syncState.pending ?? state.sync.pending ?? 0,
      lastResult: syncState,
      cursor: state.sync.cursor ?? 0,
    };
    refreshSyncStatus().catch(() => {});
    // A sync can deliver conflicts, and it can also carry a licence bought elsewhere or a
    // refund, so both are refreshed rather than waiting for a restart.
    refreshConflicts().catch(() => {});
    refreshEntitlements().catch(() => {});
  });
  document.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.hasAttribute("data-close-dialog")) {
      target.closest("dialog")?.close("cancel");
      return;
    }
    if (target.dataset.toggleGroup) {
      const groupId = target.dataset.toggleGroup;
      if (state.expandedGroups.has(groupId)) state.expandedGroups.delete(groupId);
      else state.expandedGroups.add(groupId);
      renderProperties();
      return;
    }
    if (target.dataset.addPropertyToPlace) {
      openPropertyDialog(null, { placeId: target.dataset.addPropertyToPlace, kind: "cottage" });
      return;
    }
    if (target.hasAttribute("data-add-standalone-house")) {
      openPropertyDialog(null, { placeId: null, kind: "house" });
      return;
    }
    if (target.dataset.calendarProperty) {
      const reservationId = target.dataset.calendarReservation;
      if (reservationId) {
        openReservationDialog(state.reservations.find((item) => item.id === reservationId));
      } else {
        openReservationDialog(null, {
          propertyId: target.dataset.calendarProperty,
          checkInDate: target.dataset.calendarDate,
          checkOutDate: addDaysIso(target.dataset.calendarDate),
        });
      }
      return;
    }
    if (target.dataset.pageJump) navigate(target.dataset.pageJump);
    if (target.dataset.quick === "property") openPropertyDialog();
    if (target.dataset.quick === "place") openPlaceDialog();
    if (target.dataset.quick === "reservation") openReservationDialog();
    if (target.dataset.editProperty) openPropertyDialog(state.properties.find((item) => item.id === target.dataset.editProperty));
    if (target.dataset.editPlace) openPlaceDialog(state.places.find((item) => item.id === target.dataset.editPlace));
    if (target.dataset.editReservation) openReservationDialog(state.reservations.find((item) => item.id === target.dataset.editReservation));
    if (target.dataset.earlyCheckout) openEarlyCheckoutDialog(state.reservations.find((item) => item.id === target.dataset.earlyCheckout));
    if (target.dataset.archiveProperty) {
      const property = state.properties.find((item) => item.id === target.dataset.archiveProperty);
      confirmAction({
        title: "Архивировать дом?",
        text: `«${property.name}» исчезнет из новых броней, но история сохранится.`,
        button: "Архивировать",
        action: async () => {
          await unwrap(api.properties.archive(property.id));
          await refreshCore();
          toast("Дом перенесён в архив");
        },
      });
    }
    if (target.dataset.restoreProperty) {
      unwrap(api.properties.restore(target.dataset.restoreProperty))
        .then(refreshCore)
        .then(() => toast("Дом восстановлен"))
        .catch((error) => toast(error.message, "error"));
    }
    if (target.dataset.archivePlace) {
      const place = state.places.find((item) => item.id === target.dataset.archivePlace);
      confirmAction({
        title: "Архивировать дом отдыха?",
        text: `«${place.name}» будет скрыт из выбора для новых коттеджей. Сами коттеджи и их брони сохранятся.`,
        button: "Архивировать",
        action: async () => {
          await unwrap(api.places.archive(place.id));
          await refreshCore();
          toast("Дом отдыха перенесён в архив");
        },
      });
    }
    if (target.dataset.restorePlace) {
      unwrap(api.places.restore(target.dataset.restorePlace))
        .then(refreshCore)
        .then(() => toast("Дом отдыха восстановлен"))
        .catch((error) => toast(error.message, "error"));
    }
    if (target.dataset.editRental) {
      const rental = (state.rentals || []).find((item) => item.id === target.dataset.editRental);
      if (rental) openRentalDialog(rental);
      return;
    }

    if (target.dataset.conflictAction) {
      const action = target.dataset.conflictAction;
      const reservationId = target.dataset.id;
      const conflict = (state.conflicts || []).find((item) => item.id === reservationId);
      if (!conflict) return;

      if (action === "cancel") {
        confirmAction({
          title: "Отменить конфликтующую бронь?",
          text: `Бронь для ${conflict.guest_name} будет отменена, а даты освободятся. Запись сохранится в истории.`,
          button: "Отменить бронь",
          action: () => resolveConflict(reservationId, "cancel"),
        });
      } else {
        resolveConflict(reservationId, action);
      }
      return;
    }

    if (target.dataset.cancelReservation) {
      const reservation = state.reservations.find((item) => item.id === target.dataset.cancelReservation);
      confirmAction({
        title: "Отменить бронь?",
        text: `Бронь №${reservation.id} для ${reservation.guest_name} будет отменена, а ночи освободятся.`,
        button: "Отменить бронь",
        action: async () => {
          await unwrap(api.reservations.cancel(reservation.id));
          await refreshCore();
          toast("Бронь отменена");
        },
      });
    }
    if (target.dataset.documentsReservation) {
      openDocumentsDialog(target.dataset.documentsReservation);
    }
    if (target.dataset.contractRental) {
      createDocument(target.dataset.contractRental, "contract")
        .catch((error) => toast(error.message, "error"));
    }
    if (target.dataset.invoiceRental) {
      createDocument(target.dataset.invoiceRental, "invoice")
        .catch((error) => toast(error.message, "error"));
    }
    if (target.dataset.deleteReservation) {
      const reservation = state.reservations.find((item) => item.id === target.dataset.deleteReservation);
      confirmAction({
        title: "Удалить бронь навсегда?",
        text: `Бронь №${reservation.id} для ${reservation.guest_name} (${shortDate(reservation.check_in_date)} → ${shortDate(reservation.actual_check_out_date || reservation.check_out_date)}) будет безвозвратно удалена. Отменить это действие нельзя.`,
        button: "Удалить навсегда",
        action: async () => {
          await unwrap(api.reservations.delete(reservation.id));
          await refreshCore();
          toast("Бронь удалена");
        },
      });
    }
  });

  $("#primaryAction").addEventListener("click", () => {
    const action = $("#primaryAction").dataset.actionType || PAGE_META[state.page].actionType;
    if (action === "property") openPropertyDialog();
    else if (action === "backup") createBackup();
    else if (action === "rental") openRentalDialog();
    else openReservationDialog();
  });

  $("#propertyForm").addEventListener("submit", submitProperty);
  $("#placeForm").addEventListener("submit", submitPlace);
  $("#placeForm").elements.hasFoodService.addEventListener("change", togglePlaceFoodPrices);
  $("#reservationForm").addEventListener("submit", submitReservation);
  $("#earlyCheckoutForm").addEventListener("submit", submitEarlyCheckout);
  // Changing what is being sold or when re-opens the question of price, so an amount typed for
  // the previous dates stops applying. Nothing the owner typed is discarded silently: the reset
  // button and the help text both say which mode the field is in.
  const requote = () => {
    state.accommodationManual = false;
    recalculateReservationTotal();
  };
  $("#reservationProperty").addEventListener("change", () => {
    applyPropertyDefaults();
    renderMealInputs();
    requote();
  });
  ["checkInDate", "checkOutDate"].forEach((name) => {
    $("#reservationForm").elements[name].addEventListener("change", () => {
      const form = $("#reservationForm");
      if (
        name === "checkInDate" &&
        form.elements.checkInDate.value &&
        form.elements.checkOutDate.value <= form.elements.checkInDate.value
      ) {
        form.elements.checkOutDate.value = addDaysIso(form.elements.checkInDate.value);
      }
      updateReservationDateLimits();
      renderMealInputs();
      requote();
    });
  });
  ["prepaid", "deposit"].forEach((name) => {
    $("#reservationForm").elements[name].addEventListener("input", renderReservationCalculation);
  });
  // Typing an amount for one booking is how an owner agrees a price the rules do not produce —
  // a returning guest, a damaged week, a favour. It replaces the computed figure for THIS
  // booking only; the unit's rules are untouched, and the button puts the calculation back.
  $("#reservationForm").elements.accommodation.addEventListener("input", () => {
    state.accommodationManual = true;
    renderReservationCalculation();
  });
  $("#resetAccommodation").addEventListener("click", () => {
    state.accommodationManual = false;
    $("#reservationForm").elements.accommodation.value = state.quote
      ? minorToDecimal(state.quote.totalMinor)
      : "0.00";
    renderReservationCalculation();
  });
  $("#earlyCheckoutForm").elements.actualCheckOutDate.addEventListener("change", renderEarlyCheckoutPreview);
  $$('input[name="billingPolicy"]', $("#earlyCheckoutForm")).forEach((input) => input.addEventListener("change", renderEarlyCheckoutPreview));
  $("#showArchived").addEventListener("change", renderProperties);
  $("#globalSearch").addEventListener("input", (event) => {
    state.search = event.target.value.trim();
    if (state.page === "properties") renderProperties();
    if (state.page === "reservations") renderReservations();
  });
  $$("[data-reservation-filter]").forEach((button) => button.addEventListener("click", () => {
    state.reservationFilter = button.dataset.reservationFilter;
    $$("[data-reservation-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderReservations();
  }));
  // The rate-rule editor: add a row, remove a row. Delegated, because the rows are rebuilt from
  // the stored rules every time the dialog opens and a listener bound to a row would be lost with
  // it — the previous element is replaced, not edited.
  $("#addStayDiscount").addEventListener("click", () => {
    $("#stayDiscountRows").insertAdjacentHTML("beforeend", discountRow("minimumNights", "ночей", { minimumNights: 7, percent: 10 }));
  });
  $("#addTenancyDiscount").addEventListener("click", () => {
    $("#tenancyDiscountRows").insertAdjacentHTML("beforeend", discountRow("minimumMonths", "месяцев", { minimumMonths: 12, percent: 10 }));
  });
  $("#addSeason").addEventListener("click", () => {
    const today = state.systemInfo?.bookingPolicy?.today || new Date().toISOString().slice(0, 10);
    $("#seasonRows").insertAdjacentHTML("beforeend", `
      <div class="rule-row season-row" data-rule-row>
        <label class="field"><span>Название</span><input data-rule-field="name" maxlength="80" placeholder="Новый год"></label>
        <label class="field"><span>Первая ночь</span><input data-rule-field="from" type="date" value="${addDaysIso(today, 30)}"></label>
        <label class="field"><span>Последняя ночь</span><input data-rule-field="to" type="date" value="${addDaysIso(today, 37)}"></label>
        <label class="field"><span>Цена за ночь</span><div class="money-input"><input data-rule-field="nightlyRateMinor" type="number" min="0" step="0.01" value="0"><span>₼</span></div></label>
        <button type="button" class="icon-button danger" data-remove-rule aria-label="Удалить сезон">${icon("i-trash")}</button>
      </div>`);
  });
  $("#propertyForm").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-rule]");
    if (!button) return;
    button.closest("[data-rule-row]")?.remove();
  });

  $$("[data-document-kind]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.documentKind;
    const reservationId = state.documentsReservation;
    if (!reservationId) return;
    createDocument(reservationId, kind).catch((error) => showError($("#documentsError"), error));
  }));
  $("#openDocumentsFolder").addEventListener("click", () => {
    unwrap(api.documents.openFolder()).catch((error) => toast(error.message, "error"));
  });
  $("#requisitesForm")?.addEventListener("submit", (event) => {
    submitRequisites(event).catch((error) => toast(error.message, "error"));
  });
  $("#createBackup").addEventListener("click", createBackup);
  $("#interfaceLanguage").addEventListener("change", changeInterfaceLanguage);
  $("#textScale")?.addEventListener("change", (event) => {
    event.currentTarget.value = applyTextScale(event.currentTarget.value);
  });
  $("#openDatabaseFolder").addEventListener("click", () => {
    unwrap(api.system.openBackupDirectory()).catch((error) => toast(error.message, "error"));
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (state.page === "properties") openPropertyDialog();
      else openReservationDialog();
    }
  });
}

function showLogin() {
  $("#loginScreen").classList.remove("is-hidden");
  showLoginStep("loginStepEmail");
  $("#loginEmailError").hidden = true;
  $("#loginCodeError").hidden = true;
  $("#loginCodeHint").hidden = true;
  $("#loginEmail").value = state.loginEmail || "";
  setTimeout(() => $("#loginEmail").focus(), 60);
}

function hideLogin() {
  const screen = $("#loginScreen");
  screen.classList.add("is-leaving");
  setTimeout(() => {
    screen.classList.add("is-hidden");
    screen.classList.remove("is-leaving");
  }, 260);
}

function showLoginStep(id) {
  ["loginStepEmail", "loginStepCode", "loginStepPlan"].forEach((stepId) => {
    const step = $(`#${stepId}`);
    const active = stepId === id;
    step.hidden = !active;
    step.classList.toggle("is-active", active);
  });
}

function showPlanStep() {
  $("#loginPlanError").hidden = true;
  showLoginStep("loginStepPlan");
  $("#loginPlanHeading").textContent = "Выберите тариф";
  setTimeout(() => $("#loginStepPlan button.login-submit").focus(), 60);
}

function applySession(session) {
  state.session = session;
  const container = $("#cloudStatus");
  if (session) {
    const email = session.user?.email || session.accountName || "";
    const planLabel = { free: "Бесплатный", pro: "Pro", business: "Business" }[session.plan] || session.plan || "";
    $("#cloudAccount").innerHTML = `<strong>${escapeHtml(session.accountName || email)}</strong><span>${escapeHtml(planLabel)}</span>`;
    container.hidden = false;
  } else {
    container.hidden = true;
  }
}

function clearSessionUI() {
  state.session = null;
  $("#cloudStatus").hidden = true;
  $("#cloudAccount").innerHTML = "";
}

async function enterApp() {
  try {
    await refreshCore();
    navigate("dashboard");
  } catch (error) {
    toast(`Не удалось загрузить базу: ${error.message}`, "error");
  }
}

async function requestLoginCode() {
  const email = $("#loginEmail").value.trim();
  $("#loginEmailError").hidden = true;
  if (!email) {
    showError($("#loginEmailError"), new Error("Укажите email"));
    return;
  }
  const button = $("#loginEmailSubmit");
  setBusy(button, true, "Отправка…");
  try {
    state.loginEmail = email;
    let result = await unwrap(api.auth.send(email));
    if (result?.loginable === false) {
      try {
        // Provisioning the account makes the address loginable, but the code the send above
        // already issued remains valid — it is keyed by address, not by account. Asking for a
        // SECOND code here would be refused by the send throttle (one per address per minute),
        // which is exactly how first-run signup used to fail: the account was created and the
        // user was left staring at "too many requests". Reuse the code when the server echoed
        // one, which it does only with AUTH_EXPOSE_CODE on.
        const alreadyIssued = result?.code;
        await unwrap(api.auth.setup(email));
        // Provisioning the account is exactly what makes the address loginable, so the
        // judgement made a moment ago is now stale. Without this, the client rejects the
        // account it just created — "no account for this email" on the user's own signup.
        result = alreadyIssued ? { ...result, loginable: true } : await unwrap(api.auth.send(email));
      } catch (setupError) {
        if (setupError?.code !== "user_exists") throw setupError;
      }
    }
    if (result?.loginable === false) {
      throw new Error("Учётная запись для этого email не найдена. Обратитесь к владельцу аккаунта.");
    }
    $("#loginCodeEmail").textContent = email;
    const codeHint = $("#loginCodeHint");
    if (result?.code) {
      codeHint.textContent = `Dev-режим: ваш код — ${result.code}`;
      codeHint.hidden = false;
    } else {
      codeHint.hidden = true;
    }
    $("#loginCode").value = "";
    $("#loginCodeError").hidden = true;
    showLoginStep("loginStepCode");
    setTimeout(() => $("#loginCode").focus(), 60);
  } catch (error) {
    showError($("#loginEmailError"), error);
  } finally {
    setBusy(button, false);
  }
}

async function submitLoginCode() {
  const code = $("#loginCode").value.trim();
  $("#loginCodeError").hidden = true;
  if (!/^\d{6}$/.test(code)) {
    showError($("#loginCodeError"), new Error("Код состоит из 6 цифр"));
    return;
  }
  const button = $("#loginCodeSubmit");
  setBusy(button, true, "Вход…");
  try {
    const result = await unwrap(api.auth.verify(state.loginEmail, code));
    applySession(result);
    // SessionView carries the account's plan, so an account that is already paid skips the
    // picker instead of being asked on every sign-in. A free account still sees it.
    if (result?.plan && result.plan !== "free") await enterAppAfterLogin();
    else showPlanStep();
  } catch (error) {
    showError($("#loginCodeError"), error);
  } finally {
    setBusy(button, false);
  }
}

async function submitPlanSelection() {
  const selected = document.querySelector('input[name="plan"]:checked')?.value;
  const button = $("#loginPlanSubmit");
  setBusy(button, true, "Сохранение…");
  try {
    if (selected === "business") {
      // `PATCH /account/plan` is the endpoint this server exposes. It is legacy
      // subscription plumbing: the paid tier now comes from an entitlement, and no client
      // route creates one, so this call cannot grant a licence either way. It is attempted
      // rather than skipped, and any failure is reported plainly.
      const refreshed = await unwrap(api.auth.setPlan("business"));
      if (refreshed) applySession(refreshed);
    }
    await enterAppAfterLogin();
  } catch (error) {
    if (error?.status === 404) {
      showError($("#loginPlanError"), new Error("Смена тарифа пока недоступна. Можно продолжить на бесплатном тарифе."));
    } else {
      showError($("#loginPlanError"), error);
    }
  } finally {
    setBusy(button, false);
  }
}

async function enterAppAfterLogin() {
  hideLogin();
  await enterApp();
}

function bindAuthEvents() {
  $("#loginEmailForm").addEventListener("submit", (event) => {
    event.preventDefault();
    requestLoginCode();
  });
  $("#loginCodeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitLoginCode();
  });
  $("#loginResend").addEventListener("click", requestLoginCode);
  $("#loginBack").addEventListener("click", showLogin);
  $("#loginPlanBack").addEventListener("click", showLogin);
  $("#loginPlanSubmit").addEventListener("click", submitPlanSelection);
  $("#logoutButton").addEventListener("click", async () => {
    try {
      await api.auth.logout();
    } catch (error) {
      console.warn("Logout failed; clearing local session", error);
    }
    clearSessionUI();
    $("#loginEmail").value = state.loginEmail || "";
    showLogin();
  });
}

async function boot() {
  bindEvents();
  bindAuthEvents();
  // Before anything renders, so the login screen is already at the reader's chosen size.
  applyTextScale(textScaleName());
  // The controls that reflect a device preference are synced here rather than only in
  // renderSettings(), which runs when the settings PAGE is opened. Otherwise the panel is stale
  // until it has been visited once — the preference is in force while the control denies it.
  const textScale = $("#textScale");
  if (textScale) textScale.value = textScaleName();
  try {
    const systemInfo = await unwrap(api.system.info());
    window.i18n?.setLanguage(systemInfo.language || "ru");
  } catch {
    // language falls back to Russian if the local database is not reachable yet
  }
  const hasAuthApi = Boolean(api.auth && api.auth.status);
  if (!hasAuthApi) {
    showLogin();
    return;
  }
  try {
    const status = await unwrap(api.auth.status());
    state.authBaseUrl = status.baseUrl;
    if (status?.authenticated && status.session) {
      applySession(status.session);
      hideLogin();
      await enterApp();
      return;
    }
  } catch (error) {
    // Backend unreachable or no valid session: show only the login screen.
    // The app data UI stays gated behind authentication.
    console.warn("Auth restore failed", error);
  }
  showLogin();
}

async function init() {
  await boot();
}

function createBrowserDemoApi() {
  const storageKey = "dombook.web.v1";
  let interfaceLanguage = "ru";
  let places = [
    { id: "1", name: "Дом отдыха «Лесная долина»", address: "Габала", has_food_service: 1, status: "active", notes: "", active_unit_count: 2, total_unit_count: 2 },
  ];
  let properties = [
    { id: "1", place_id: "1", place_name: "Дом отдыха «Лесная долина»", place_address: "Габала", kind: "cottage", name: "Коттедж «Сосны»", location: "", capacity: 6, base_price_minor: 24000, deposit_minor: 30000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 1 },
    { id: "2", place_id: "1", place_name: "Дом отдыха «Лесная долина»", place_address: "Габала", kind: "cottage", name: "Коттедж «У озера»", location: "", capacity: 8, base_price_minor: 32000, deposit_minor: 40000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 0 },
    { id: "3", place_id: null, place_name: null, place_address: null, kind: "house", name: "Отдельный дом в Шеки", location: "Шеки", capacity: 3, base_price_minor: 17000, deposit_minor: 20000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 0 },
  ];
  let reservations = [];
  let backups = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved) {
      if (Array.isArray(saved.places)) places = normalizeIds(saved.places);
      if (Array.isArray(saved.properties)) properties = normalizeIds(saved.properties);
      if (Array.isArray(saved.reservations)) reservations = normalizeIds(saved.reservations);
      if (Array.isArray(saved.backups)) backups = saved.backups;
      if (["ru", "az", "en"].includes(saved.language)) interfaceLanguage = saved.language;
    }
  } catch (error) {
    console.warn("RentKeeper web storage could not be restored", error);
  }
  const response = (data) => Promise.resolve({ ok: true, data });
  const error = (message) => Promise.resolve({ ok: false, error: message });
  let requisites = {};
  const documentPreviewHtml = () => "<!doctype html><p>Документ формируется в приложении для компьютера.</p>";
  const idOf = (value) => (value === null || value === undefined ? null : String(value));
  const findById = (list, id, key = "id") => list.find((item) => idOf(item[key]) === idOf(id));
  const normalizeIds = (list, keys = ["id", "place_id", "property_id", "reservation_id"]) => (list || []).map((item) => {
    const copy = { ...item };
    keys.forEach((key) => { if (copy[key] !== null && copy[key] !== undefined) copy[key] = String(copy[key]); });
    return copy;
  });
  const persist = () => localStorage.setItem(storageKey, JSON.stringify({
    version: 1,
    language: interfaceLanguage,
    places,
    properties,
    reservations,
    backups,
  }));
  const persistedResponse = (data) => {
    persist();
    return response(data);
  };
  const exportBackup = () => {
    const createdAt = new Date();
    const file = `rentkeeper-web-${createdAt.toISOString().replaceAll(":", "-")}.json`;
    const payload = JSON.stringify({ version: 1, exportedAt: createdAt.toISOString(), places, properties, reservations }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const backup = { file, size: blob.size, createdAt: createdAt.toISOString() };
    backups = [backup, ...backups].slice(0, 20);
    return persistedResponse(backup);
  };
  const list = () => reservations.map((item) => {
    const property = findById(properties, item.property_id);
    return { ...item, property_name: property?.name || "—", place_name: property?.place_name || null, currency: "AZN", balance_minor: Math.max(item.total_minor - item.prepaid_minor, 0), refund_due_minor: Math.max(item.prepaid_minor - item.total_minor, 0) };
  });
  const demoReservation = (data, previous = null) => {
    const property = findById(properties, data.propertyId);
    const place = findById(places, property?.place_id);
    const nights = nightsBetween(data.checkInDate, data.checkOutDate);
    const nightlyRate = previous?.nightly_rate_minor || property.base_price_minor;
    const meals = place?.has_food_service
      ? (data.mealItems || []).filter((item) => Number(item.amountMinor) > 0)
      : [];
    const servicesMinor = meals.reduce((sum, item) => sum + Number(item.amountMinor), 0);
    const accommodationMinor = nightlyRate * nights;
    return {
      property_id: data.propertyId, guest_name: data.guestName, guest_phone: data.guestPhone,
      guest_email: data.guestEmail, check_in_date: data.checkInDate, check_out_date: data.checkOutDate,
      adults: data.adults, children: data.children, status: data.status, nightly_rate_minor: nightlyRate,
      accommodation_minor: accommodationMinor, services_minor: servicesMinor,
      total_minor: accommodationMinor + servicesMinor, prepaid_minor: data.prepaidMinor,
      deposit_minor: data.depositMinor, deposit_status: data.depositStatus, notes: data.notes,
      actual_check_out_date: previous?.actual_check_out_date || null,
      meals: meals.map((item) => ({
        reservation_id: previous?.id || null,
        meal_date: item.date,
        meal_type: item.type,
        amount_minor: item.amountMinor,
      })),
    };
  };
  return {
    dashboard: { get: () => response({ today: new Date().toISOString().slice(0, 10), activeProperties: properties.filter((p) => p.status === "active").length, activeReservations: reservations.filter((r) => ["hold", "confirmed", "checked_in"].includes(r.status)).length, expectedMinor: reservations.reduce((sum, r) => sum + Math.max(r.total_minor - r.prepaid_minor, 0), 0), refundsDueMinor: reservations.reduce((sum, r) => sum + Math.max(r.prepaid_minor - r.total_minor, 0), 0), depositsHeldMinor: reservations.filter((r) => r.deposit_status === "received").reduce((sum, r) => sum + r.deposit_minor, 0), arrivals: [], departures: [] }) },
    calendar: { get: (days = 14) => {
      const start = new Date();
      const dates = Array.from({ length: days }, (_, index) => new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10));
      const occupancy = [];
      reservations.filter((r) => !["cancelled", "no_show"].includes(r.status)).forEach((r) => {
        for (let cursor = new Date(`${r.check_in_date}T00:00:00`); cursor < new Date(`${r.actual_check_out_date || r.check_out_date}T00:00:00`); cursor = new Date(cursor.getTime() + 86_400_000)) {
          occupancy.push({ property_id: r.property_id, night_date: cursor.toISOString().slice(0, 10), reservation_id: r.id, guest_name: r.guest_name, status: r.status });
        }
      });
      return response({ dates, properties: properties.filter((p) => p.status === "active"), occupancy });
    } },
    places: {
      list: () => response(places),
      create: (data) => { if (places.some((p) => p.name.toLowerCase() === data.name.toLowerCase())) return error("Дом отдыха с таким названием уже существует"); const item = { id: String(Date.now()), name: data.name, address: data.address, has_food_service: data.hasFoodService ? 1 : 0, notes: data.notes, status: "active", active_unit_count: 0, total_unit_count: 0 }; places.push(item); return persistedResponse(item); },
      update: (id, data) => { const item = findById(places, id); Object.assign(item, { name: data.name, address: data.address, has_food_service: data.hasFoodService ? 1 : 0, notes: data.notes }); properties.filter((property) => idOf(property.place_id) === idOf(id)).forEach((property) => Object.assign(property, { place_name: item.name, place_address: item.address })); return persistedResponse(item); },
      archive: (id) => { findById(places, id).status = "archived"; return persistedResponse(true); },
      restore: (id) => { findById(places, id).status = "active"; return persistedResponse(true); },
    },
    properties: {
      list: () => response(properties),
      create: (data) => { if (properties.some((p) => p.name.toLowerCase() === data.name.toLowerCase())) return error("Дом с таким наименованием уже существует"); const place = findById(places, data.placeId); const item = { id: String(Date.now()), place_id: data.placeId || null, place_name: place?.name || null, place_address: place?.address || null, kind: data.kind, name: data.name, location: data.location, capacity: data.capacity, base_price_minor: data.basePriceMinor, deposit_minor: data.depositMinor, currency: data.currency, check_in_time: data.checkInTime, check_out_time: data.checkOutTime, notes: data.notes, status: "active", reservation_count: 0 }; properties.push(item); return persistedResponse(item); },
      update: (id, data) => { const item = findById(properties, id); const place = findById(places, data.placeId); Object.assign(item, { place_id: data.placeId || null, place_name: place?.name || null, place_address: place?.address || null, kind: data.kind, name: data.name, location: data.location, capacity: data.capacity, base_price_minor: data.basePriceMinor, deposit_minor: data.depositMinor, currency: data.currency, check_in_time: data.checkInTime, check_out_time: data.checkOutTime, notes: data.notes }); return persistedResponse(item); },
      archive: (id) => { findById(properties, id).status = "archived"; return persistedResponse(true); },
      restore: (id) => { findById(properties, id).status = "active"; return persistedResponse(true); },
    },
    reservations: {
      list: () => response(list()),
      create: (data) => { const item = { id: String(Date.now()), ...demoReservation(data) }; reservations.push(item); return persistedResponse(item); },
      update: (id, data) => { const item = findById(reservations, id); Object.assign(item, demoReservation(data, item)); return persistedResponse(item); },
      cancel: (id) => { findById(reservations, id).status = "cancelled"; return persistedResponse(true); },
      delete: (id) => { reservations = reservations.filter((r) => !(idOf(r.id) === idOf(id))); return persistedResponse(true); },
      earlyCheckout: (id, data) => {
        const item = findById(reservations, id);
        item.actual_check_out_date = data.actualCheckOutDate;
        item.status = "checked_out";
        item.meals = (item.meals || []).filter((meal) => meal.meal_date < data.actualCheckOutDate);
        item.services_minor = item.meals.reduce((sum, meal) => sum + Number(meal.amount_minor), 0);
        if (data.billingPolicy !== "keep_total") {
          item.accommodation_minor = item.nightly_rate_minor * nightsBetween(item.check_in_date, data.actualCheckOutDate);
        }
        item.total_minor = item.accommodation_minor + item.services_minor;
        return persistedResponse(item);
      },
    },
    backups: { list: () => response(backups), create: exportBackup },
    system: {
      info: () => {
        const today = new Date().toISOString().slice(0, 10);
        return response({
          databasePath: "Browser local storage",
          backupDir: "Browser downloads",
          databaseSize: new Blob([localStorage.getItem(storageKey) || ""]).size,
          bookingPolicy: {
            today,
            maximumCheckInDate: addDaysIso(today, 21),
            maximumCheckOutDate: null,
            maximumAdvanceDays: 21,
            maximumStayMonths: 3,
            timeZone: "Asia/Baku",
          },
          language: interfaceLanguage,
        });
      },
      setLanguage: (language) => {
        interfaceLanguage = ["ru", "az", "en"].includes(language) ? language : "ru";
        return persistedResponse(interfaceLanguage);
      },
      openBackupDirectory: () => response(true),
      setDocumentRequisites: (data) => {
        requisites = { ...requisites, ...data };
        return persistedResponse(requisites);
      },
    },
    // The browser build has no Electron main process to render a PDF in, so a document is
    // downloaded as an HTML file instead of silently doing nothing. The demo is a preview of the
    // product, and a button that appears to work is more honest than one that is missing.
    documents: {
      html: (data) => response(documentPreviewHtml(data)),
      create: () => error("PDF создаётся только в приложении для компьютера"),
      folder: () => response("Browser downloads"),
      openFolder: () => response("Browser downloads"),
    },
  };
}

init();
