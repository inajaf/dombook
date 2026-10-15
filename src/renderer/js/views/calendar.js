/**
 * The occupancy timeline.
 *
 * A booking is ONE bar spanning the nights it holds, not the guest's name repeated in every cell.
 * The repeated version made a fortnight look like fourteen separate bookings, and it hid the two
 * things a calendar is read for: where each stay starts and ends, and which nights are still free
 * between them.
 *
 * The bars are placed on the same CSS grid as the day cells, by explicit row and column, and they
 * take no pointer events: the CELL underneath keeps the click, so opening a booking and creating
 * one are the same gestures they were before, and the bar is purely what you see.
 *
 * Placement is applied through the CSSOM and NOT as a `style="…"` attribute. The page's
 * Content-Security-Policy is `style-src 'self'`, which does not include `'unsafe-inline'`, so a
 * style ATTRIBUTE is parsed into the DOM and then ignored — `getAttribute('style')` shows it while
 * `getComputedStyle` reports `auto`. A bar with no placement is laid out on a row of its own, and
 * the grid fell back to 14 day columns for every range, which is invisible as long as 14 is the
 * default and wrong the moment it is not.
 */

import { $, escapeHtml } from "../dom.js";
import { state } from "../store.js";
import { guestCountLabel, interfaceLocale, money, nightsBetween, shortDate } from "../formatters.js";

/** The ranges the owner can choose between. 14 fits a laptop, 30 fits a month of planning. */
export const CALENDAR_RANGES = [14, 21, 30];

const STATUS_LABELS = {
  hold: "Холд",
  confirmed: "Подтверждена",
  checked_in: "Заехал",
  checked_out: "Выехал",
  cancelled: "Отменена",
  no_show: "Не приехал",
  conflict: "Конфликт",
};

/**
 * Group a property's occupied nights into the runs a guest actually occupies.
 *
 * A booking is contiguous by definition, but the window can cut one in half — which is why the
 * run also reports whether it was cut, so the bar can be drawn flush against the edge instead of
 * looking like a booking that begins there.
 */
function bookingRuns(occupancy, propertyId, dates) {
  const index = new Map(dates.map((date, position) => [date, position]));
  const byReservation = new Map();
  for (const night of occupancy) {
    if (night.property_id !== propertyId) continue;
    if (!byReservation.has(night.reservation_id)) byReservation.set(night.reservation_id, []);
    byReservation.get(night.reservation_id).push(night);
  }
  const runs = [];
  for (const [reservationId, nights] of byReservation) {
    const positions = nights
      .map((night) => index.get(night.night_date))
      .filter((position) => position !== undefined)
      .sort((a, b) => a - b);
    if (!positions.length) continue;
    let start = positions[0];
    let previous = positions[0];
    for (const position of positions.slice(1).concat([null])) {
      if (position !== null && position === previous + 1) {
        previous = position;
        continue;
      }
      runs.push({
        reservationId,
        status: nights[0].status,
        guestName: nights[0].guest_name,
        from: start,
        to: previous,
        // The booking's own first/last night is not in this window when the run touches an edge
        // and the reservation extends past it.
        cutStart: start === 0,
        cutEnd: previous === dates.length - 1,
      });
      if (position === null) break;
      start = position;
      previous = position;
    }
  }
  return runs;
}

/** What the popover says about one booking: who, when, how much, and what is still owed. */
function popoverHtml(reservation, visible) {
  // The nights of the STAY, not of the window: a booking the window cuts in half still lasts what
  // it lasts, and a card that reports the visible sliver as "1 ночь" is wrong in the one place a
  // person checks it against the dates printed right beside it.
  const nights = nightsBetween(reservation.check_in_date, reservation.check_out_date) || visible;
  const owed = Math.max((reservation.total_minor || 0) - (reservation.prepaid_minor || 0), 0);
  const payment = reservation.total_minor
    ? owed > 0
      ? `Остаток ${money(owed, reservation.currency)}`
      : "Оплачено полностью"
    : "Сумма не указана";
  const contact = reservation.guest_phone || reservation.guest_email || "Контакт не указан";
  return `
    <div class="calendar-popover-inner">
      <div class="calendar-popover-head">
        <strong data-i18n-ignore>${escapeHtml(reservation.guest_name)}</strong>
        <span class="pill ${reservation.status === "hold" ? "warn" : ""}">${escapeHtml(STATUS_LABELS[reservation.status] || reservation.status)}</span>
      </div>
      <dl class="calendar-popover-rows">
        <div><dt>Даты</dt><dd data-i18n-ignore>${escapeHtml(shortDate(reservation.check_in_date))} — ${escapeHtml(shortDate(reservation.check_out_date))} · ${nights} ${nights === 1 ? "ночь" : nights < 5 ? "ночи" : "ночей"}</dd></div>
        ${visible < nights ? `<div><dt>В окне</dt><dd>${visible} из ${nights} ночей — остальное за пределами показанных дат</dd></div>` : ""}
        <div><dt>Гость</dt><dd data-i18n-ignore>${escapeHtml(contact)}${reservation.adults ? ` · ${escapeHtml(guestCountLabel((reservation.adults || 0) + (reservation.children || 0)))}` : ""}</dd></div>
        <div><dt>Объект</dt><dd data-i18n-ignore>${escapeHtml(reservation.property_name || "")}</dd></div>
        <div><dt>Оплата</dt><dd>${escapeHtml(payment)}</dd></div>
      </dl>
      <p class="calendar-popover-hint">Нажмите, чтобы открыть бронь</p>
    </div>`;
}

/**
 * What the visible window holds, in the numbers a manager actually asks for.
 *
 * The calendar showed which nights were taken and nothing about the period as a whole, so "how
 * full are we over these two weeks" meant counting squares. Occupancy is counted from the same
 * occupancy rows the bars are drawn from, so the summary and the picture cannot disagree.
 */
function periodSummary(data) {
  const dates = data.dates;
  const nights = new Set(dates);
  const taken = data.occupancy.filter((row) => nights.has(row.night_date));
  const capacity = data.properties.length * dates.length;
  const load = capacity ? Math.round((taken.length / capacity) * 100) : 0;
  const first = dates[0];
  const last = dates[dates.length - 1];
  const reservations = (state.reservations || []).filter((item) => !["cancelled", "no_show"].includes(item.status));
  const arrivals = reservations.filter((item) => item.check_in_date >= first && item.check_in_date <= last).length;
  const departures = reservations.filter((item) => item.check_out_date >= first && item.check_out_date <= last).length;
  const revenue = reservations
    .filter((item) => item.check_in_date <= last && item.check_out_date >= first)
    .reduce((sum, item) => sum + Math.max((item.total_minor || 0) - (item.prepaid_minor || 0), 0), 0);
  return { taken: taken.length, capacity, load, arrivals, departures, revenue, currency: reservations[0]?.currency || "AZN" };
}

/**
 * The next stretch of free nights on a unit, inside the window — the question an owner is asked on
 * the phone ("when can we come?") and the one thing a grid of crosses makes you count.
 */
function freeWindow(data, propertyId) {
  const taken = new Set(
    data.occupancy.filter((row) => row.property_id === propertyId).map((row) => row.night_date),
  );
  let best = { start: null, nights: 0 };
  let run = 0;
  for (const date of data.dates) {
    if (taken.has(date)) {
      run = 0;
      continue;
    }
    run += 1;
    if (run > best.nights) best = { start: date, nights: run };
  }
  return best;
}

function navHtml(dates) {
  // A segmented control rather than a <select>: three options on a toolbar are a view-density
  // switch, and a form control sitting in a toolbar reads as a setting someone has to open.
  const ranges = CALENDAR_RANGES
    .map((days) => `<button type="button" class="range-option ${days === state.calendarDays ? "is-active" : ""}"
        data-calendar-range="${days}" aria-pressed="${days === state.calendarDays}">${days}</button>`)
    .join("");
  return `
    <div class="calendar-nav">
      <div class="calendar-nav-group">
        <button type="button" class="button ghost compact" data-calendar-nav="-1" aria-label="Предыдущий период" title="Предыдущий период (←)">←</button>
        <button type="button" class="button ghost compact" data-calendar-nav="today" title="Вернуться к сегодняшнему дню">Сегодня</button>
        <button type="button" class="button ghost compact" data-calendar-nav="1" aria-label="Следующий период" title="Следующий период (→)">→</button>
      </div>
      <span class="calendar-nav-range" data-i18n-ignore>${escapeHtml(shortDate(dates[0]))} — ${escapeHtml(shortDate(dates[dates.length - 1]))}</span>
      <div class="calendar-range" role="group" aria-label="Сколько дней показывать">
        <span class="calendar-range-label">Дней</span>${ranges}
      </div>
    </div>`;
}

export function renderCalendar() {
  const data = state.calendar || { dates: [], properties: [], occupancy: [], startDate: null };
  const container = $("#calendarContainer");
  if (!container) return;

  if (!data.properties.length) {
    container.innerHTML = `<div class="empty-state"><h3>Нет активных домов</h3><p>Добавьте или восстановите дом, чтобы увидеть календарь.</p></div>`;
    return;
  }

  const maximumCheckInDate = state.systemInfo?.bookingPolicy?.maximumCheckInDate;
  const today = state.systemInfo?.bookingPolicy?.today;
  const byKey = new Map(data.occupancy.map((item) => [`${item.property_id}:${item.night_date}`, item]));

  const headers = data.dates.map((date, column) => {
    const parsed = new Date(`${date}T00:00:00`);
    const weekday = new Intl.DateTimeFormat(interfaceLocale(), { weekday: "short" }).format(parsed);
    const weekend = parsed.getDay() === 0 || parsed.getDay() === 6;
    return `<div class="calendar-cell calendar-head ${date === today ? "is-today" : ""} ${weekend ? "is-weekend" : ""}" data-place-row="1" data-place-column="${column + 2}"><span><strong>${parsed.getDate()}</strong>${escapeHtml(weekday)}</span></div>`;
  }).join("");

  const rows = data.properties.map((property, rowIndex) => {
    const row = rowIndex + 2;
    const propertyContext = property.place_name || property.location || "Отдельный дом";
    const cells = data.dates.map((date, column) => {
      const booking = byKey.get(`${property.id}:${date}`);
      const outsideBookingWindow = !booking && maximumCheckInDate && date > maximumCheckInDate;
      const label = booking
        ? `Открыть бронь ${booking.guest_name} на ${shortDate(date)}`
        : outsideBookingWindow
          ? `Новая бронь на ${shortDate(date)} недоступна: максимум 21 день вперёд`
          : `Создать бронь для ${property.name} с ${shortDate(date)}`;
      return `<button type="button" class="calendar-cell calendar-night ${booking ? "is-booked" : outsideBookingWindow ? "is-outside-window" : "is-free"}"
        data-place-row="${row}" data-place-column="${column + 2}"
        data-calendar-property="${property.id}" data-calendar-date="${date}" data-today="${date === today ? "1" : "0"}"
        ${booking ? `data-calendar-reservation="${booking.reservation_id}"` : ""}
        ${outsideBookingWindow ? "disabled" : ""}
        aria-label="${escapeHtml(label)}">${
        booking ? "" : outsideBookingWindow
          ? `<span class="calendar-limit" aria-hidden="true">21+</span>`
          : `<span class="calendar-free" aria-hidden="true">+</span>`}</button>`;
    }).join("");

    // One bar per stay, drawn over the cells it covers.
    const bars = bookingRuns(data.occupancy, property.id, data.dates).map((run) => `
      <div class="timeline-bar ${run.status} ${run.cutStart ? "is-cut-start" : ""} ${run.cutEnd ? "is-cut-end" : ""}"
        data-place-row="${row}" data-place-column="${run.from + 2} / ${run.to + 3}"
        data-calendar-reservation="${run.reservationId}" data-run-from="${run.from}" data-run-to="${run.to}" aria-hidden="true">
        <span class="timeline-bar-guest" data-i18n-ignore>${escapeHtml(run.guestName)}</span>
        <span class="timeline-bar-status">${escapeHtml(STATUS_LABELS[run.status] || run.status)}</span>
      </div>`).join("");

    const free = freeWindow(data, property.id);
    const freeHint = free.nights
      ? `<small class="calendar-free-hint" data-i18n-ignore>свободно ${free.nights} ${free.nights === 1 ? "ночь" : free.nights < 5 ? "ночи" : "ночей"} с ${escapeHtml(shortDate(free.start))}</small>`
      : `<small class="calendar-free-hint is-full" data-i18n-ignore>все ночи заняты</small>`;
    return `
    <div class="calendar-cell calendar-house" data-place-row="${row}" data-place-column="1">
      <span class="calendar-house-copy">
        <strong class="calendar-house-name" data-i18n-ignore title="${escapeHtml(property.name)}">${escapeHtml(property.name)}</strong>
        <small class="calendar-house-context" ${property.place_name || property.location ? "data-i18n-ignore" : ""} title="${escapeHtml(propertyContext)}">${escapeHtml(propertyContext)}</small>
        ${freeHint}
      </span>
    </div>
    ${cells}${bars}`;
  }).join("");

  const summary = periodSummary(data);
  container.innerHTML = `
    ${navHtml(data.dates)}
    <div class="calendar-summary">
      <span class="calendar-stat"><strong>${summary.load}%</strong> занято</span>
      <span class="calendar-stat">${summary.taken} из ${summary.capacity} ночей</span>
      <span class="calendar-stat">Заездов <strong>${summary.arrivals}</strong></span>
      <span class="calendar-stat">Выездов <strong>${summary.departures}</strong></span>
      ${summary.revenue > 0 ? `<span class="calendar-stat">К доплате <strong data-i18n-ignore>${escapeHtml(money(summary.revenue, summary.currency))}</strong></span>` : ""}
    </div>
    <div class="calendar-scroll">
      <div class="calendar-grid">
        <div class="calendar-cell calendar-head calendar-house" data-place-row="1" data-place-column="1">Дом</div>
        ${headers}${rows}
      </div>
    </div>
    <div class="calendar-popover" id="calendarPopover" hidden></div>`;

  // The grid is told how wide it is, and each element where it belongs, through the CSSOM — see the
  // note at the top of this file for why an attribute would be silently ignored.
  const grid = container.querySelector(".calendar-grid");
  grid.style.setProperty("--calendar-days", String(data.dates.length));
  for (const element of container.querySelectorAll("[data-place-row]")) {
    element.style.gridRow = element.dataset.placeRow;
    element.style.gridColumn = element.dataset.placeColumn;
  }
}

/**
 * Show the popover for the reservation under the pointer.
 *
 * It is positioned from the bar's own box rather than following the cursor: a card that runs away
 * from the pointer is harder to read than one that sits still next to what it describes.
 */
export function showCalendarPopover(target) {
  const popover = $("#calendarPopover");
  const reservationId = target?.dataset?.calendarReservation;
  if (!popover || !reservationId) return hideCalendarPopover();
  const reservation = (state.reservations || []).find((item) => item.id === reservationId);
  const bar = target.closest(".calendar-grid")?.querySelector(`.timeline-bar[data-calendar-reservation="${reservationId}"]`);
  if (!reservation || !bar) return hideCalendarPopover();

  // What the bar actually covers, read from the bar itself: the popover describes the thing the
  // pointer is on, not a second calculation that could disagree with it.
  const from = Number(bar.dataset.runFrom ?? 0);
  const to = Number(bar.dataset.runTo ?? from);
  popover.innerHTML = popoverHtml(reservation, to - from + 1);
  popover.hidden = false;

  // Above the bar when there is room, below it when there is not, and never off the edge.
  const grid = popover.parentElement.getBoundingClientRect();
  const box = bar.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const left = Math.min(Math.max(box.left - grid.left, 8), Math.max(grid.width - width - 8, 8));
  const above = box.top - grid.top - height - 8;
  popover.style.left = `${left}px`;
  popover.style.top = `${above > 0 ? above : box.bottom - grid.top + 8}px`;
}

export function hideCalendarPopover() {
  const popover = $("#calendarPopover");
  if (popover) popover.hidden = true;
}
