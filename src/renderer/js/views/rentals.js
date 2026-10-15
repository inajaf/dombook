/**
 * Аренда: the long lets, which are reservations with a kind rather than a second inventory.
 *
 * `applyKindToDialog` is here because the dialog's behaviour IS the tenancy rule — a monthly rate,
 * a month count, no nights — and keeping that beside the list is what stops the two drifting.
 */

import { $, escapeHtml, $$ } from "../dom.js";
import { state } from "../store.js";
import { readMeterReadings } from "./properties.js";
import { longDate, money, reservationStatusLabel, addCalendarMonthsIso, minorToDecimal } from "../formatters.js";

export function renderRentals() {
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

export function applyKindToDialog(kind) {
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

/** Open the reservation dialog as a rental. */
export function openRentalDialog(rental = null) {
  // Rentals are reservations, so this is the ordinary dialog with the kind preset. A second
  // dialog would be a second place for validation to diverge.
  openReservationDialog(rental, { bookingKind: "rental" });
}
