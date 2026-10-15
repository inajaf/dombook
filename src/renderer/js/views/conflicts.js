/**
 * Конфликты: bookings two devices disagreed about, and what to do with each.
 *
 * Nothing here decides anything on its own — the resolution is sent to the main process, which is
 * where the version comparison that produced the conflict lives.
 */

import { $, escapeHtml } from "../dom.js";
import { state } from "../store.js";
import { runtime } from "../runtime.js";
import { toast } from "../toast.js";
import { api, unwrap } from "../api.js";

export function renderConflicts() {
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

/** Reload the conflict queue from the local database. */
export async function refreshConflicts() {
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

/** Show how many bookings need a decision. */
export function updateConflictBadge() {
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

/**
 * Resolve a conflict.
 *
 * Both actions release the conflicting booking's claim on the dates. "Reschedule" opens the
 * ordinary reservation editor, so moving the guest is the same flow as editing any booking
 * rather than a separate mechanism that could behave differently.
 */
export async function resolveConflict(reservationId, action) {
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
