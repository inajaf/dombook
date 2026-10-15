/**
 * «Сегодня»: what is happening now, and what it is worth.
 *
 * Read-only by design — every number here is a summary of work done elsewhere, and a dashboard
 * with its own edits is a second place for the same facts to be wrong.
 */

import { $, escapeHtml } from "../dom.js";
import { state } from "../store.js";
import { guestCountLabel, money, shortDate } from "../formatters.js";

export function renderDashboard() {
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
