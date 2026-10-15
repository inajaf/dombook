/**
 * The units, and the two dialogs that edit one.
 *
 * `activeProperties` lives here rather than in the shell because "bookable" is this page's own
 * judgement: the management list shows archived units and the booking dialog must not, and having
 * one function answer both questions is how an archived unit ends up sellable.
 */

import { $, $$, escapeHtml, icon, setBusy, showError } from "../dom.js";
import { state } from "../store.js";
import { runtime } from "../runtime.js";
import { toast } from "../toast.js";
import { api, unwrap } from "../api.js";
import { capacityLabel, decimalToMinor, money, objectCountLabel, shortDate, minorToDecimal } from "../formatters.js";

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

export function activeProperties() {
  return state.properties.filter((property) => property.status === "active");
}

export function renderProperties() {
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

export function readMeterReadings(raw) {
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

export function openPropertyDialog(property = null, defaults = {}) {
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

export function openPlaceDialog(place = null) {
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

export async function submitProperty(event) {
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
    await runtime.refresh();
    toast(id ? "Дом обновлён" : "Дом создан");
  } catch (error) {
    showError(errorBox, error);
  } finally {
    setBusy(submit, false);
  }
}

export async function submitPlace(event) {
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
    await runtime.refresh();
    toast(id ? "Дом отдыха обновлён" : "Дом отдыха создан");
  } catch (error) {
    showError(errorBox, error);
  } finally {
    setBusy(submit, false);
  }
}

export function togglePlaceFoodPrices() {
  // Цены вводятся вручную для каждого дня уже при создании брони.
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

export function discountRow(thresholdField, unitLabel, entry) {
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
