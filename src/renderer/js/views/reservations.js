/**
 * The booking list.
 *
 * The filter lives beside the list rather than in the shell: what "active" or "debt" means is a
 * question about this table, and a filter that can be asked for from anywhere is one that will be
 * asked for with the wrong state set.
 */

import { $, escapeHtml, icon } from "../dom.js";
import { state } from "../store.js";
import { STATUS_LABELS, DEPOSIT_LABELS, balanceLabel, money, shortDate, reservationStatusLabel } from "../formatters.js";

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

export function renderReservations() {
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
