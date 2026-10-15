/**
 * Настройки: the licence, the booking window, the sync state, the printed documents' details, and
 * the people who may sign in.
 *
 * The page is a collection of unrelated panels, which is what a settings page IS — but each panel
 * owns its own refresh, so opening the page does not fetch what it does not show.
 */

import { $, escapeHtml, icon, setBusy, showError } from "../dom.js";
import { state } from "../store.js";
import { runtime } from "../runtime.js";
import { toast } from "../toast.js";
import { api, unwrap } from "../api.js";
import { refreshConflicts } from "./conflicts.js";
import { ROLE_LABELS, formatBytes, interfaceLocale, privateStorageLabel } from "../formatters.js";
import { textScaleName } from "../theme.js";

export function renderSettings() {
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

/** Load the account's licence, falling back to the cached copy. *//** Load the account's licence, falling back to the cached copy. */
export async function refreshEntitlements() {
  const response = await window.domBook.entitlements.get();
  if (!response.ok) return;
  state.entitlements = response.data || null;
  renderEntitlements();
}

/** Render the sync panel in settings. */

/** Read the current sync state from the main process. */
export async function refreshSyncStatus() {
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
export async function purchaseLicense() {
  toast("Онлайн-оплата ещё не подключена. Напишите нам, чтобы получить лицензию.");
}

/** Load the account's licence, falling back to the cached copy. *//** Load the account's licence, falling back to the cached copy. */

export async function submitRequisites(event) {
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

/** Save a policy change. */
export async function saveBookingPolicy(event) {
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

/** Load the account's booking window, falling back to the cached copy when offline. */
export async function refreshBookingPolicy() {
  const response = await window.domBook.bookingPolicy.get();
  if (!response.ok) return;
  state.bookingPolicy = response.data || null;
  renderPolicy();
}

/** Save a policy change. */

export async function refreshTeam() {
  const list = $("#teamList");
  if (!list) return;
  try {
    const [members, invites] = await Promise.all([
      unwrap(api.team.members()),
      // The invitation list is owner/admin only. A member who is refused still sees the team,
      // so the panel does not disappear for them — it just drops the part they may not read.
      unwrap(api.team.invites()).catch(() => null),
    ]);
    const team = members?.members || [];
    $("#teamBadge").textContent = `${team.length} ${team.length === 1 ? "человек" : "человека"}`;
    list.innerHTML = team.map((member) => `
      <div class="team-row">
        <span class="team-avatar">${escapeHtml((member.name || member.email || "?").trim().charAt(0).toUpperCase())}</span>
        <span><strong data-i18n-ignore>${escapeHtml(member.name || member.email)}</strong>
          <small data-i18n-ignore>${escapeHtml(member.email)}</small></span>
        <span class="pill">${escapeHtml(ROLE_LABELS[member.role] || member.role)}${member.isSelf ? " · это вы" : ""}</span>
      </div>`).join("");

    const pending = (invites?.invites || []).filter((invite) => invite.status === "pending");
    $("#inviteList").innerHTML = pending.length
      ? `<h3 class="team-heading">Ожидают входа</h3>${pending.map((invite) => `
          <div class="team-row">
            <span class="team-avatar pending">${icon("i-key")}</span>
            <span><strong data-i18n-ignore>${escapeHtml(invite.email)}</strong>
              <small>приглашён ${escapeHtml(new Date(invite.createdAt).toLocaleDateString(interfaceLocale()))}, действует до ${escapeHtml(new Date(invite.expiresAt).toLocaleDateString(interfaceLocale()))}</small></span>
            <span class="pill">${escapeHtml(ROLE_LABELS[invite.role] || invite.role)}</span>
            <button type="button" class="button ghost compact" data-revoke-invite="${escapeHtml(invite.id)}">Отозвать</button>
          </div>`).join("")}`
      : "";
    // Nothing to invite with, for someone who may not invite.
    $("#inviteForm").hidden = invites === null;
  } catch (error) {
    list.innerHTML = `<p class="empty-inline">${escapeHtml(error.message)}</p>`;
  }
}

export async function submitInvite(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("#inviteError");
  const successBox = $("#inviteSuccess");
  errorBox.hidden = true;
  successBox.hidden = true;
  const submit = $("#inviteSubmit");
  try {
    setBusy(submit, true);
    await unwrap(api.team.invite(form.elements.email.value.trim(), form.elements.role.value));
    successBox.textContent = "Приглашение создано. Человек войдёт с этого адреса и увидит данные аккаунта.";
    successBox.hidden = false;
    form.reset();
    await refreshTeam();
  } catch (error) {
    showError(errorBox, error);
  } finally {
    setBusy(submit, false);
  }
}

/** The details a contract prints, kept in app_settings so they follow the owner between devices. */

/** Ask the main process to sync now, then refresh what the UI shows. */
export async function syncNow() {
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
  await runtime.refresh();
  await refreshConflicts();
}

/** Read the current sync state from the main process. */
