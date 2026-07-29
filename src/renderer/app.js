const PAGE_META = {
  dashboard: { eyebrow: "Рабочий день", title: "Сегодня", action: "Новая бронь", actionType: "reservation", search: false },
  calendar: { eyebrow: "Доступность", title: "Календарь", action: "Новая бронь", actionType: "reservation", search: false },
  reservations: { eyebrow: "Гости и деньги", title: "Бронирования", action: "Новая бронь", actionType: "reservation", search: true },
  properties: { eyebrow: "Инвентарь", title: "Объекты", action: "Добавить объект", actionType: "property", search: true },
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
  reservationFilter: "all",
  search: "",
  expandedGroups: new Set(),
};

const api = window.domBook || createBrowserDemoApi();
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

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
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(minor || 0) / 100);
}

function objectCountLabel(count) {
  const value = Number(count || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${value} объектов`;
  if (mod10 === 1) return `${value} объект`;
  if (mod10 >= 2 && mod10 <= 4) return `${value} объекта`;
  return `${value} объектов`;
}

function shortDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" })
    .format(new Date(`${value}T00:00:00`))
    .replace(".", "");
}

function longDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" })
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
  setTimeout(() => element.remove(), 4000);
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
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

async function refreshCore() {
  const [places, properties, reservations, dashboard, calendar] = await Promise.all([
    unwrap(api.places.list({ includeArchived: true })),
    unwrap(api.properties.list({ includeArchived: true })),
    unwrap(api.reservations.list()),
    unwrap(api.dashboard.get()),
    unwrap(api.calendar.get(14)),
  ]);
  Object.assign(state, { places, properties, reservations, dashboard, calendar });
  renderDashboard();
  renderCalendar();
  renderReservations();
  renderProperties();
  updateBadge();
}

async function refreshSettings() {
  const [backups, systemInfo] = await Promise.all([
    unwrap(api.backups.list()),
    unwrap(api.system.info()),
  ]);
  Object.assign(state, { backups, systemInfo });
  renderSettings();
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
  $("#searchBox").hidden = !meta.search;
  if (!meta.search) {
    state.search = "";
    $("#globalSearch").value = "";
  }
  if (page === "settings") refreshSettings().catch((error) => toast(error.message, "error"));
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
          <span><strong>${escapeHtml(item.guest_name)}</strong><small>${escapeHtml(item.place_name ? `${item.place_name} · ${item.property_name}` : item.property_name)} · ${item.adults + item.children} гостей</small></span>
          <span class="operation-tag ${item.type}">${item.label}</span>
        </div>
      `).join("")}</div>`
    : `<div class="empty-inline">На сегодня заездов и выездов нет. Можно спокойно проверить будущие брони.</div>`;
}

function renderCalendar() {
  const data = state.calendar || { dates: [], properties: [], occupancy: [] };
  const byKey = new Map(data.occupancy.map((item) => [`${item.property_id}:${item.night_date}`, item]));
  if (!data.properties.length) {
    $("#calendarContainer").innerHTML = `<div class="empty-state"><h3>Нет активных домов</h3><p>Добавьте или восстановите дом, чтобы увидеть календарь.</p></div>`;
    return;
  }
  const headers = data.dates.map((date) => {
    const parsed = new Date(`${date}T00:00:00`);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(parsed);
    return `<div class="calendar-cell calendar-head"><span><strong>${parsed.getDate()}</strong>${escapeHtml(weekday)}</span></div>`;
  }).join("");
  const rows = data.properties.map((property) => `
    <div class="calendar-cell calendar-house"><span>${escapeHtml(property.name)}<small>${escapeHtml(property.place_name || property.location || "Отдельный дом")}</small></span></div>
    ${data.dates.map((date) => {
      const booking = byKey.get(`${property.id}:${date}`);
      const label = booking
        ? `Открыть бронь ${booking.guest_name} на ${longDate(date)}`
        : `Создать бронь для ${property.name} с ${longDate(date)}`;
      return `<button type="button" class="calendar-cell calendar-night ${booking ? "is-booked" : "is-free"}"
        data-calendar-property="${property.id}" data-calendar-date="${date}"
        ${booking ? `data-calendar-reservation="${booking.reservation_id}"` : ""}
        aria-label="${escapeHtml(label)}">${booking
        ? `<span class="calendar-booking ${booking.status}" title="${escapeHtml(booking.guest_name)}">${escapeHtml(booking.guest_name)}</span>`
        : `<span class="calendar-free" aria-hidden="true">+</span>`}</button>`;
    }).join("")}
  `).join("");
  $("#calendarContainer").innerHTML = `<div class="calendar-scroll"><div class="calendar-grid"><div class="calendar-cell calendar-head calendar-house">Дом</div>${headers}${rows}</div></div>`;
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
  $("#reservationTableBody").innerHTML = reservations.map((reservation) => `
    <tr>
      <td class="primary-cell"><strong>${escapeHtml(reservation.guest_name)}</strong><small>${escapeHtml(reservation.guest_phone || reservation.guest_email || "Контакт не указан")}</small></td>
      <td class="primary-cell"><strong>${escapeHtml(reservation.property_name)}</strong><small>${escapeHtml(reservation.place_name || "Отдельный дом")}</small></td>
      <td class="date-range">${shortDate(reservation.check_in_date)} → ${shortDate(reservation.actual_check_out_date || reservation.check_out_date)}${reservation.actual_check_out_date ? "<small>досрочно</small>" : ""}</td>
      <td><span class="status-badge status-${reservation.status}">${STATUS_LABELS[reservation.status]}</span></td>
      <td class="money-stack"><strong>${money(reservation.prepaid_minor, reservation.currency)}</strong><small>${reservation.refund_due_minor > 0 ? `к возврату ${money(reservation.refund_due_minor, reservation.currency)}` : `остаток ${money(reservation.balance_minor, reservation.currency)}`}</small></td>
      <td class="money-stack"><strong>${money(reservation.deposit_minor, reservation.currency)}</strong><small>${DEPOSIT_LABELS[reservation.deposit_status]}</small></td>
      <td><div class="row-actions">
        <button class="icon-button" data-edit-reservation="${reservation.id}" aria-label="Редактировать бронь ${escapeHtml(reservation.guest_name)}">${icon("i-edit")}</button>
        ${["hold", "confirmed", "checked_in"].includes(reservation.status) ? `<button class="button secondary row-text-action" data-early-checkout="${reservation.id}">Досрочный выезд</button>` : ""}
        ${["cancelled", "checked_out", "no_show"].includes(reservation.status) ? "" : `<button class="icon-button danger" data-cancel-reservation="${reservation.id}" aria-label="Отменить бронь ${escapeHtml(reservation.guest_name)}">${icon("i-close")}</button>`}
        ${["cancelled", "checked_out", "no_show"].includes(reservation.status) ? `<button class="icon-button danger" data-delete-reservation="${reservation.id}" aria-label="Удалить бронь ${escapeHtml(reservation.guest_name)} навсегда">${icon("i-trash")}</button>` : ""}
      </div></td>
    </tr>
  `).join("");
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
          <div><h3>${escapeHtml(property.name)}</h3><p>${escapeHtml(property.location || property.place_address || "Расположение не указано")}</p><span class="property-kind">${property.kind === "cottage" ? "Коттедж" : "Отдельный дом"}</span></div>
          <div class="property-price">${money(property.base_price_minor, property.currency)}<small>за ночь</small></div>
        </div>
        <div class="property-meta">
          <div><small>Гостей</small><strong>до ${property.capacity}</strong></div>
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
            <h3>${escapeHtml(group.place?.name || "Отдельные дома")}</h3>
            <p>${escapeHtml(group.place?.address || "Сдаются самостоятельно")} · ${objectCountLabel(group.units.length)}</p>
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

function renderSettings() {
  const info = state.systemInfo || {};
  $("#systemInfo").innerHTML = `
    <div><dt>Файл базы</dt><dd>${escapeHtml(info.databasePath || "—")}</dd></div>
    <div><dt>Размер</dt><dd>${formatBytes(info.databaseSize || 0)}</dd></div>
    <div><dt>Папка копий</dt><dd>${escapeHtml(info.backupDir || "—")}</dd></div>
  `;
  $("#backupList").innerHTML = state.backups.length ? state.backups.slice(0, 8).map((backup) => `
    <div class="backup-row">
      <span>${icon("i-database")}</span>
      <span><strong>${escapeHtml(backup.file)}</strong><small>${new Date(backup.createdAt).toLocaleString("ru-RU")}</small></span>
      <small>${formatBytes(backup.size)}</small>
    </div>
  `).join("") : `<div class="empty-inline">Копий пока нет. Создайте первую перед внесением реальных данных.</div>`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1_048_576).toFixed(1)} МБ`;
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
  form.elements.deposit.value = minorToDecimal(property?.deposit_minor);
  form.elements.checkInTime.value = property?.check_in_time || "15:00";
  form.elements.checkOutTime.value = property?.check_out_time || "11:00";
  form.elements.notes.value = property?.notes || "";
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
  $("#reservationProperty").innerHTML = houses.map((property) =>
    `<option value="${property.id}">${escapeHtml(property.place_name ? `${property.place_name} — ${property.name}` : property.name)} · до ${property.capacity} гостей</option>`
  ).join("");
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const afterTomorrow = new Date(today.getTime() + 2 * 86_400_000);
  form.elements.id.value = reservation?.id || "";
  form.elements.propertyId.value = reservation?.property_id || defaults.propertyId || houses[0].id;
  form.elements.checkInDate.value = reservation?.check_in_date || defaults.checkInDate || tomorrow.toISOString().slice(0, 10);
  form.elements.checkOutDate.value = reservation?.check_out_date || defaults.checkOutDate || afterTomorrow.toISOString().slice(0, 10);
  form.elements.guestName.value = reservation?.guest_name || "";
  form.elements.guestPhone.value = reservation?.guest_phone || "";
  form.elements.guestEmail.value = reservation?.guest_email || "";
  form.elements.adults.value = reservation?.adults || 2;
  form.elements.children.value = reservation?.children || 0;
  form.elements.accommodation.value = minorToDecimal(reservation?.accommodation_minor);
  form.elements.prepaid.value = minorToDecimal(reservation?.prepaid_minor);
  form.elements.status.value = reservation?.status || "hold";
  form.elements.notes.value = reservation?.notes || "";
  $("#reservationMealDays").innerHTML = "";
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
  const property = state.properties.find((item) => item.id === Number(form.elements.propertyId.value));
  if (!property || existingReservation) return;
  form.elements.deposit.value = minorToDecimal(property.deposit_minor);
  form.elements.depositStatus.value = property.deposit_minor > 0 ? "due" : "none";
}

function selectedPlace() {
  const form = $("#reservationForm");
  const property = state.properties.find((item) => item.id === Number(form.elements.propertyId.value));
  return state.places.find((item) => item.id === property?.place_id) || null;
}

function mealDateLabel(value) {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "long" })
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
  const reservation = state.reservations.find((item) => item.id === Number(form.elements.id.value));
  const checkIn = form.elements.checkInDate.value;
  const plannedCheckOut = form.elements.checkOutDate.value;
  const checkOut = reservation?.actual_check_out_date || plannedCheckOut;
  if (!checkIn || !checkOut || nightsBetween(checkIn, checkOut) < 1) return [];
  const dates = [];
  for (let cursor = checkIn; cursor < checkOut && dates.length < 730; cursor = addDaysIso(cursor)) {
    dates.push(cursor);
  }
  return dates;
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
  const property = state.properties.find((item) => item.id === Number(form.elements.propertyId.value));
  const nights = nightsBetween(form.elements.checkInDate.value, form.elements.checkOutDate.value);
  const accommodationMinor = decimalToMinor(form.elements.accommodation.value);
  const servicesMinor = $$("[data-meal-amount]", $("#reservationMealDays"))
    .reduce((sum, input) => sum + decimalToMinor(input.value), 0);
  $$("[data-meal-day]", $("#reservationMealDays")).forEach((row) => {
    const dayTotal = $$("[data-meal-amount]", row).reduce((sum, input) => sum + decimalToMinor(input.value), 0);
    $("[data-meal-day-total]", row).textContent = money(dayTotal, property?.currency);
  });
  const totalMinor = accommodationMinor + servicesMinor;
  const prepaidMinor = decimalToMinor(form.elements.prepaid.value);
  const depositMinor = decimalToMinor(form.elements.deposit.value);
  $("#calculationNights").textContent = `${nights} ${nights === 1 ? "ночь" : nights < 5 ? "ночи" : "ночей"}`;
  $("#calculationFormula").textContent = property && nights
    ? `${money(property.base_price_minor, property.currency)} × ${nights}`
    : "Выберите корректные даты";
  $("#calculationTotal").textContent = money(totalMinor, property?.currency);
  $("#calculationServices").textContent = money(servicesMinor, property?.currency);
  $("#calculationPrepaid").textContent = money(prepaidMinor, property?.currency);
  $("#calculationBalance").textContent = money(Math.max(0, totalMinor - prepaidMinor), property?.currency);
  $("#calculationDeposit").textContent = money(depositMinor, property?.currency);
}

function recalculateReservationTotal() {
  const form = $("#reservationForm");
  const property = state.properties.find((item) => item.id === Number(form.elements.propertyId.value));
  const nights = nightsBetween(form.elements.checkInDate.value, form.elements.checkOutDate.value);
  if (property && nights) {
    const reservation = state.reservations.find((item) => item.id === Number(form.elements.id.value));
    const nightlyRate = reservation && reservation.property_id === property.id
      ? reservation.nightly_rate_minor
      : property.base_price_minor;
    form.elements.accommodation.value = minorToDecimal(nightlyRate * nights);
  } else {
    form.elements.accommodation.value = "0.00";
  }
  renderReservationCalculation();
}

async function submitProperty(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = $("#propertySubmit");
  const errorBox = $("#propertyFormError");
  errorBox.hidden = true;
  const payload = {
    placeId: form.elements.placeId.value ? Number(form.elements.placeId.value) : null,
    kind: form.elements.kind.value,
    name: form.elements.name.value,
    location: form.elements.location.value,
    capacity: Number(form.elements.capacity.value),
    currency: form.elements.currency.value,
    basePriceMinor: decimalToMinor(form.elements.basePrice.value),
    depositMinor: decimalToMinor(form.elements.deposit.value),
    checkInTime: form.elements.checkInTime.value,
    checkOutTime: form.elements.checkOutTime.value,
    notes: form.elements.notes.value,
    status: state.properties.find((item) => item.id === Number(form.elements.id.value))?.status || "active",
  };
  try {
    setBusy(submit, true);
    const id = Number(form.elements.id.value);
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
  const id = Number(form.elements.id.value);
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
    propertyId: Number(form.elements.propertyId.value),
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
    const id = Number(form.elements.id.value);
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
  const reservation = state.reservations.find((item) => item.id === Number(form.elements.id.value));
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
    await unwrap(api.reservations.earlyCheckout(Number(form.elements.id.value), {
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
      openPropertyDialog(null, { placeId: Number(target.dataset.addPropertyToPlace), kind: "cottage" });
      return;
    }
    if (target.hasAttribute("data-add-standalone-house")) {
      openPropertyDialog(null, { placeId: null, kind: "house" });
      return;
    }
    if (target.dataset.calendarProperty) {
      const reservationId = Number(target.dataset.calendarReservation);
      if (reservationId) {
        openReservationDialog(state.reservations.find((item) => item.id === reservationId));
      } else {
        openReservationDialog(null, {
          propertyId: Number(target.dataset.calendarProperty),
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
    if (target.dataset.editProperty) openPropertyDialog(state.properties.find((item) => item.id === Number(target.dataset.editProperty)));
    if (target.dataset.editPlace) openPlaceDialog(state.places.find((item) => item.id === Number(target.dataset.editPlace)));
    if (target.dataset.editReservation) openReservationDialog(state.reservations.find((item) => item.id === Number(target.dataset.editReservation)));
    if (target.dataset.earlyCheckout) openEarlyCheckoutDialog(state.reservations.find((item) => item.id === Number(target.dataset.earlyCheckout)));
    if (target.dataset.archiveProperty) {
      const property = state.properties.find((item) => item.id === Number(target.dataset.archiveProperty));
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
      unwrap(api.properties.restore(Number(target.dataset.restoreProperty)))
        .then(refreshCore)
        .then(() => toast("Дом восстановлен"))
        .catch((error) => toast(error.message, "error"));
    }
    if (target.dataset.archivePlace) {
      const place = state.places.find((item) => item.id === Number(target.dataset.archivePlace));
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
      unwrap(api.places.restore(Number(target.dataset.restorePlace)))
        .then(refreshCore)
        .then(() => toast("Дом отдыха восстановлен"))
        .catch((error) => toast(error.message, "error"));
    }
    if (target.dataset.cancelReservation) {
      const reservation = state.reservations.find((item) => item.id === Number(target.dataset.cancelReservation));
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
    if (target.dataset.deleteReservation) {
      const reservation = state.reservations.find((item) => item.id === Number(target.dataset.deleteReservation));
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
    else openReservationDialog();
  });

  $("#propertyForm").addEventListener("submit", submitProperty);
  $("#placeForm").addEventListener("submit", submitPlace);
  $("#placeForm").elements.hasFoodService.addEventListener("change", togglePlaceFoodPrices);
  $("#reservationForm").addEventListener("submit", submitReservation);
  $("#earlyCheckoutForm").addEventListener("submit", submitEarlyCheckout);
  $("#reservationProperty").addEventListener("change", () => {
    applyPropertyDefaults();
    renderMealInputs();
    recalculateReservationTotal();
  });
  ["checkInDate", "checkOutDate"].forEach((name) => {
    $("#reservationForm").elements[name].addEventListener("change", () => {
      renderMealInputs();
      recalculateReservationTotal();
    });
  });
  ["prepaid", "deposit"].forEach((name) => {
    $("#reservationForm").elements[name].addEventListener("input", renderReservationCalculation);
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
  $("#createBackup").addEventListener("click", createBackup);
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

async function init() {
  bindEvents();
  try {
    await refreshCore();
    navigate("dashboard");
  } catch (error) {
    toast(`Не удалось загрузить базу: ${error.message}`, "error");
  }
}

function createBrowserDemoApi() {
  let places = [
    { id: 1, name: "Дом отдыха «Лесная долина»", address: "Габала", has_food_service: 1, status: "active", notes: "", active_unit_count: 2, total_unit_count: 2 },
  ];
  let properties = [
    { id: 1, place_id: 1, place_name: "Дом отдыха «Лесная долина»", place_address: "Габала", kind: "cottage", name: "Коттедж «Сосны»", location: "", capacity: 6, base_price_minor: 24000, deposit_minor: 30000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 1 },
    { id: 2, place_id: 1, place_name: "Дом отдыха «Лесная долина»", place_address: "Габала", kind: "cottage", name: "Коттедж «У озера»", location: "", capacity: 8, base_price_minor: 32000, deposit_minor: 40000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 0 },
    { id: 3, place_id: null, place_name: null, place_address: null, kind: "house", name: "Отдельный дом в Шеки", location: "Шеки", capacity: 3, base_price_minor: 17000, deposit_minor: 20000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 0 },
  ];
  let reservations = [];
  const response = (data) => Promise.resolve({ ok: true, data });
  const error = (message) => Promise.resolve({ ok: false, error: message });
  const list = () => reservations.map((item) => {
    const property = properties.find((p) => p.id === item.property_id);
    return { ...item, property_name: property?.name || "—", place_name: property?.place_name || null, currency: "AZN", balance_minor: Math.max(item.total_minor - item.prepaid_minor, 0), refund_due_minor: Math.max(item.prepaid_minor - item.total_minor, 0) };
  });
  const demoReservation = (data, previous = null) => {
    const property = properties.find((item) => item.id === data.propertyId);
    const place = places.find((item) => item.id === property?.place_id);
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
      create: (data) => { if (places.some((p) => p.name.toLowerCase() === data.name.toLowerCase())) return error("Дом отдыха с таким названием уже существует"); const item = { id: Date.now(), name: data.name, address: data.address, has_food_service: data.hasFoodService ? 1 : 0, notes: data.notes, status: "active", active_unit_count: 0, total_unit_count: 0 }; places.push(item); return response(item); },
      update: (id, data) => { const item = places.find((p) => p.id === id); Object.assign(item, { name: data.name, address: data.address, has_food_service: data.hasFoodService ? 1 : 0, notes: data.notes }); return response(item); },
      archive: (id) => { places.find((p) => p.id === id).status = "archived"; return response(true); },
      restore: (id) => { places.find((p) => p.id === id).status = "active"; return response(true); },
    },
    properties: {
      list: () => response(properties),
      create: (data) => { if (properties.some((p) => p.name.toLowerCase() === data.name.toLowerCase())) return error("Дом с таким наименованием уже существует"); const place = places.find((p) => p.id === data.placeId); const item = { id: Date.now(), place_id: data.placeId, place_name: place?.name || null, place_address: place?.address || null, kind: data.kind, name: data.name, location: data.location, capacity: data.capacity, base_price_minor: data.basePriceMinor, deposit_minor: data.depositMinor, currency: data.currency, check_in_time: data.checkInTime, check_out_time: data.checkOutTime, notes: data.notes, status: "active", reservation_count: 0 }; properties.push(item); return response(item); },
      update: (id, data) => { const item = properties.find((p) => p.id === id); const place = places.find((p) => p.id === data.placeId); Object.assign(item, { place_id: data.placeId, place_name: place?.name || null, place_address: place?.address || null, kind: data.kind, name: data.name, location: data.location, capacity: data.capacity, base_price_minor: data.basePriceMinor, deposit_minor: data.depositMinor, currency: data.currency, check_in_time: data.checkInTime, check_out_time: data.checkOutTime, notes: data.notes }); return response(item); },
      archive: (id) => { properties.find((p) => p.id === id).status = "archived"; return response(true); },
      restore: (id) => { properties.find((p) => p.id === id).status = "active"; return response(true); },
    },
    reservations: {
      list: () => response(list()),
      create: (data) => { const item = { id: Date.now(), ...demoReservation(data) }; reservations.push(item); return response(item); },
      update: (id, data) => { const item = reservations.find((r) => r.id === id); Object.assign(item, demoReservation(data, item)); return response(item); },
      cancel: (id) => { reservations.find((r) => r.id === id).status = "cancelled"; return response(true); },
      delete: (id) => { reservations = reservations.filter((r) => r.id !== id); return response(true); },
      earlyCheckout: (id, data) => {
        const item = reservations.find((r) => r.id === id);
        item.actual_check_out_date = data.actualCheckOutDate;
        item.status = "checked_out";
        item.meals = (item.meals || []).filter((meal) => meal.meal_date < data.actualCheckOutDate);
        item.services_minor = item.meals.reduce((sum, meal) => sum + Number(meal.amount_minor), 0);
        if (data.billingPolicy !== "keep_total") {
          item.accommodation_minor = item.nightly_rate_minor * nightsBetween(item.check_in_date, data.actualCheckOutDate);
        }
        item.total_minor = item.accommodation_minor + item.services_minor;
        return response(item);
      },
    },
    backups: { list: () => response([]), create: () => response({ file: "demo.sqlite" }) },
    system: { info: () => response({ databasePath: "Доступно в desktop-приложении", backupDir: "Доступно в desktop-приложении", databaseSize: 0 }), openBackupDirectory: () => response(true) },
  };
}

init();
