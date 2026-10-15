/**
 * The renderer's entry point: the shell.
 *
 * It owns the screen — routing between pages, redrawing after a write, the login flow — and it is
 * the only module that wires the others together. Everything else is a leaf: api.js talks to the
 * main process, store.js holds the state, formatters.js turns values into words, views/ draw a
 * page, and none of them knows about the others beyond that.
 *
 * A MODULE, loaded with <script type="module">. That works over file:// in this Electron version,
 * which is what keeps the project build-free: no bundler, no transpiler, and the file the browser
 * loads is the file in the repository.
 */

import { $, $$, escapeHtml, icon, setBusy, showError } from "./dom.js";
import { todayLabel, interfaceLocale, interfaceLanguage, money, objectCountLabel, guestCountLabel, capacityLabel, bookingWindowHelp, maximumCheckoutHelp, maximumStayHelp, balanceLabel, shortDate, longDate, decimalToMinor, minorToDecimal, addDaysIso, nightsBetween, addCalendarMonthsIso, nightLabel, monthLabel, formulaLabel, privateStorageLabel, formatBytes, reservationStatusLabel, ROLE_LABELS, STATUS_LABELS, DEPOSIT_LABELS } from "./formatters.js";
import { themeChoice, applyTheme, textScaleName, applyTextScale } from "./theme.js";
import { toast } from "./toast.js";
import { confirmAction } from "./modal.js";
import { PAGE_META, state } from "./store.js";
import { api, unwrap } from "./api.js";
import { connectShell } from "./runtime.js";
import { renderCalendar, showCalendarPopover, hideCalendarPopover, CALENDAR_RANGES } from "./views/calendar.js";
import { renderSettings, refreshEntitlements, refreshSyncStatus, purchaseLicense, submitRequisites, saveBookingPolicy, refreshBookingPolicy, refreshTeam, submitInvite, syncNow } from "./views/settings.js";
import { renderRentals, applyKindToDialog, openRentalDialog } from "./views/rentals.js";
import { renderConflicts, refreshConflicts, updateConflictBadge, resolveConflict } from "./views/conflicts.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderReservations } from "./views/reservations.js";
import { activeProperties, renderProperties, readMeterReadings, openPropertyDialog, openPlaceDialog, submitProperty, submitPlace, togglePlaceFoodPrices, discountRow } from "./views/properties.js";

async function refreshCore() {
  const [places, properties, reservations, dashboard, calendar, systemInfo] = await Promise.all([
    unwrap(api.places.list({ includeArchived: true })),
    unwrap(api.properties.list({ includeArchived: true })),
    unwrap(api.reservations.list()),
    unwrap(api.dashboard.get()),
    unwrap(api.calendar.get(state.calendarDays, state.calendarStart)),
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
  // «Сегодня» is the one page whose subject is the date, so its eyebrow IS the date. Everything
  // else keeps a phrase describing what the page holds.
  $("#pageEyebrow").textContent = page === "dashboard"
    ? todayLabel(state.systemInfo?.bookingPolicy?.today)
    : meta.eyebrow;
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
    refreshTeam().catch(() => {});
  }
  if (page === "conflicts") refreshConflicts().catch((error) => toast(error.message, "error"));
  if (page === "rentals") renderRentals();
  $("#main-content").focus({ preventScroll: true });
}







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
  // Refresh if it is not known yet; the dialog is opened from a live session, so this succeeds
  // even when the workspace was entered before the folder could be resolved.
  loadDocumentsFolder();
  renderGeneratedDocuments(reservationId);
  $("#documentsDialog").showModal();
}

async function loadDocumentsFolder() {
  try {
    state.documentsFolder = await unwrap(api.documents.folder());
  } catch {
    // A folder that cannot be resolved only costs the path line in the dialog.
    state.documentsFolder = "";
  }
  const target = $("#documentsFolderPath");
  if (target) {
    target.textContent = state.documentsFolder;
    target.hidden = !state.documentsFolder;
  }
  return state.documentsFolder;
}

async function createDocument(reservationId, kind) {
  const choose = $("#documentsChoosePath")?.checked === true;
  const openAfter = $("#documentsOpenAfter")?.checked !== false;
  const result = await unwrap(api.documents.create({ reservationId, kind, choose }));
  if (result?.canceled) return;
  // Opened straight away by default: the owner asked for a document in order to look at it, print
  // it, or send it. The checkbox is there for someone producing a batch of them.
  if (openAfter) await openDocumentFile(result.path);
  toast(`Документ сохранён: ${result.fileName}`, "success", {
    label: "Открыть",
    run: () => openDocumentFile(result.path),
  });
  renderGeneratedDocuments(reservationId);
  return result;
}

/** Hand a file to the system's own viewer. The main process decides what it will open. */
async function openDocumentFile(filePath) {
  try {
    await unwrap(api.documents.open({ filePath }));
  } catch (error) {
    toast(`Не удалось открыть файл: ${error.message}`, "error");
  }
}

/**
 * The documents already produced for this booking.
 *
 * Regenerating is not the only way to look at a contract: the file from last week is still in the
 * folder, and until this list existed the only route back to it was knowing that folder's path.
 */
async function renderGeneratedDocuments(reservationId) {
  const container = $("#documentsGenerated");
  if (!container) return;
  try {
    const files = await unwrap(api.documents.list({ reservationId }));
    container.innerHTML = files.length
      ? `<p class="rule-hint">Уже созданы:</p>${files.map((file) => `
          <div class="document-file">
            <span>${icon("i-book")}</span>
            <span><strong data-i18n-ignore>${escapeHtml(file.name)}</strong>
              <small>${escapeHtml(formatBytes(file.size))} · ${escapeHtml(new Date(file.modifiedAt).toLocaleString(interfaceLocale()))}</small></span>
            <button type="button" class="button secondary compact" data-open-document="${escapeHtml(file.path)}">Открыть</button>
            <button type="button" class="button ghost compact" data-reveal-document="${escapeHtml(file.path)}">Показать в папке</button>
          </div>`).join("")}`
      : "";
  } catch (error) {
    // A listing failure must not make the dialog look broken; the generate buttons still work.
    container.innerHTML = "";
    console.warn("Document list failed", error);
  }
}








function updateBadge() {
  const count = state.reservations.filter((item) => ["hold", "confirmed", "checked_in"].includes(item.status)).length;
  $("#reservationBadge").textContent = count;
  $("#reservationBadge").hidden = count === 0;
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
  // Delegated: the rows are rebuilt every time a document is produced.
  $("#documentsGenerated").addEventListener("click", (event) => {
    const open = event.target.closest("[data-open-document]");
    if (open) {
      openDocumentFile(open.dataset.openDocument);
      return;
    }
    const reveal = event.target.closest("[data-reveal-document]");
    if (reveal) {
      unwrap(api.documents.reveal({ filePath: reveal.dataset.revealDocument }))
        .catch((error) => toast(error.message, "error"));
    }
  });
  $("#requisitesForm")?.addEventListener("submit", (event) => {
    submitRequisites(event).catch((error) => toast(error.message, "error"));
  });
  // The calendar redraws its own markup on every refresh, so these are delegated: a listener on
  // the buttons themselves would be thrown away with them.
  $("#calendarContainer")?.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-calendar-nav]");
    if (!nav) return;
    const direction = nav.dataset.calendarNav;
    // Paging by the window's own width, so a click always moves exactly one screenful.
    if (direction === "today") {
      state.calendarStart = null;
    } else {
      const from = state.calendar?.startDate || state.systemInfo?.bookingPolicy?.today;
      if (from) state.calendarStart = addDaysIso(from, Number(direction) * state.calendarDays);
    }
    refreshCore().catch((error) => toast(error.message, "error"));
  });
  $("#calendarContainer")?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-calendar-range]");
    if (!option) return;
    const days = Number(option.dataset.calendarRange);
    if (!CALENDAR_RANGES.includes(days) || days === state.calendarDays) return;
    state.calendarDays = days;
    // The window's START is kept, so changing the range widens the view around the same first day
    // rather than jumping the owner somewhere else.
    refreshCore().catch((error) => toast(error.message, "error"));
  });
  $("#calendarContainer")?.addEventListener("mouseover", (event) => {
    const cell = event.target.closest("[data-calendar-reservation]");
    if (cell) showCalendarPopover(cell);
    else hideCalendarPopover();
  });
  $("#calendarContainer")?.addEventListener("mouseleave", hideCalendarPopover);
  // A calendar is the one screen where paging is muscle memory. The arrows in the toolbar are the
  // only way to do it with a mouse; this is the same thing with a keyboard, and it stays out of
  // the way of typing because it only fires on the calendar page with nothing focused.
  document.addEventListener("keydown", (event) => {
    if (state.page !== "calendar") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.tagName === "SELECT" || focused.isContentEditable)) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const from = state.calendar?.startDate || state.systemInfo?.bookingPolicy?.today;
    if (!from) return;
    if (event.key === "ArrowLeft" && !state.calendarStart) {
      // Left from the default window means "back", so it must become an explicit date first.
      state.calendarStart = from;
    }
    state.calendarStart = addDaysIso(from, event.key === "ArrowRight" ? state.calendarDays : -state.calendarDays);
    refreshCore().catch((error) => toast(error.message, "error"));
  });
  $("#calendarContainer")?.addEventListener("focusin", (event) => {
    const cell = event.target.closest("[data-calendar-reservation]");
    if (cell) showCalendarPopover(cell);
  });
  $("#calendarContainer")?.addEventListener("focusout", hideCalendarPopover);

  $("#inviteForm")?.addEventListener("submit", (event) => {
    submitInvite(event).catch((error) => toast(error.message, "error"));
  });
  $("#inviteList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-revoke-invite]");
    if (!button) return;
    unwrap(api.team.revokeInvite(button.dataset.revokeInvite))
      .then(() => {
        toast("Приглашение отозвано");
        return refreshTeam();
      })
      .catch((error) => toast(error.message, "error"));
  });
  $("#createBackup").addEventListener("click", createBackup);
  $("#interfaceLanguage").addEventListener("change", changeInterfaceLanguage);
  $("#themeToggle")?.addEventListener("click", () => {
    // A toggle moves between the two STATES, and lands on an explicit choice: "auto" is offered in
    // Settings, where it can be labelled, rather than being a third stop on a two-state control.
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  $("#themeSelect")?.addEventListener("change", (event) => applyTheme(event.target.value));
  // A system change must move the window while "auto" is chosen — that is the whole promise of it.
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
    if (themeChoice() === "auto") applyTheme("auto");
  });
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

/**
 * Pull once, quietly, right after the workspace opens.
 *
 * This was missing, and its absence is the worst first impression the product can make: the local
 * database is what the screen reads, so on a fresh install — or any device whose profile has just
 * been created — an owner signs in successfully and sees an EMPTY workspace. Their bookings exist;
 * they are on the server, and the only thing that would have fetched them was a 60-second timer or
 * a button hidden in Settings. "I logged in and everything is gone" is what that looks like.
 *
 * Silent, unlike the Settings button: nobody asked for this, so it must not toast on success. A
 * failure is also silent and simply leaves the local data on screen, because being offline is a
 * supported state rather than an error.
 */
async function syncAfterLogin() {
  try {
    const response = await window.domBook.sync.now();
    if (!response?.ok || response.data?.ok === false) return;
    if ((response.data?.applied || 0) > 0 || (response.data?.pushed || 0) > 0) {
      await refreshCore();
    }
  } catch {
    // Offline is a normal state; the periodic sync will catch up.
  }
}

async function enterApp() {
  try {
    await refreshCore();
    navigate("dashboard");
    // Resolved here rather than at boot: `documents:folder` needs a session, and boot runs at the
    // login screen where there is none — which left the dialog's path line permanently empty.
    loadDocumentsFolder();
    syncAfterLogin();
  } catch (error) {
    toast(`Не удалось загрузить базу: ${error.message}`, "error");
  }
}

async function requestLoginCode() {
  const email = $("#loginEmail").value.trim();
  $("#loginEmailError").hidden = true;
  state.accountCreated = false;
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
        // Remembered so the sign-in can tell "this address just became an account" from "this
        // device has never seen the account it is signing in to". The two look identical locally
        // — an empty database either way — and only the first should keep the demo sample.
        state.accountCreated = true;
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
    const result = await unwrap(api.auth.verify(state.loginEmail, code, state.accountCreated === true));
    state.accountCreated = false;
    applySession(result);
    reportAccountSwitch(result);
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

/**
 * Say so when signing in removed another account's local data.
 *
 * The switch is correct — a device's local database holds one account — but it is also the only
 * moment in the product where a sign-in can lose work, so it is never silent.
 */
function reportAccountSwitch(session) {
  if (!session?.accountSwitched) return;
  toast(
    "Вы вошли в другой аккаунт. Данные предыдущего аккаунта удалены с этого устройства — они остались на сервере.",
    "error",
  );
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
  // Before anything is bound or drawn: a view that calls a shell callback has to find one there.
  connectShell({ refresh: refreshCore, navigate, toast });
  bindEvents();
  bindAuthEvents();
  // Before anything renders, so the login screen is already at the reader's chosen size.
  applyTextScale(textScaleName());
  // theme-boot.js already put the right palette on the document; this only syncs the two controls
  // to it, so the button does not claim "Светлая" over a dark window.
  applyTheme(themeChoice());
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

/**
 * The handles the end-to-end suites drive the app through.
 *
 * They live on `window` because that is where a CDP `Runtime.evaluate` can reach them: the suites
 * reload the page, create a booking through the bridge, and then need the SHELL to redraw — which
 * is exactly what `refreshCore` does. Before the split these were globals by accident; now they
 * are exported on purpose, and this list is the contract those suites depend on.
 */
Object.assign(window, {
  state,
  PAGE_META,
  // The redraw the suites call after creating a row through the bridge: a write made behind the
  // screen's back is invisible until the shell re-reads it.
  refreshCore,
  navigate,
  activeProperties,
  openDocumentsDialog,
  openDocumentFile,
  renderGeneratedDocuments,
  openReservationDialog,
  openPropertyDialog,
  openPlaceDialog,
  openRentalDialog,
  applyTheme,
  themeChoice,
  applyTextScale,
  textScaleName,
  unwrap,
  toast,
});

// Booting here rather than in a DOMContentLoaded handler: a module is deferred, so the document is
// already parsed and every element the boot sequence reads exists.
init();

