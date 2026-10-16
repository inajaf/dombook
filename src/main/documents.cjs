/**
 * The paperwork: a rental agreement, and the invoice/act an accountant asks for.
 *
 * These are pure functions over already-loaded rows — no database, no Electron, no filesystem —
 * so the wording and the arithmetic can be asserted in a unit test rather than by opening a PDF
 * and squinting at it. `src/main.cjs` loads the rows and hands them here; `src/main/pdf.cjs`
 * renders the result.
 *
 * Two documents, because an owner needs two different things:
 *
 *   - a CONTRACT to be signed, which states the parties, the term, the rent and the deposit, and
 *     carries a signature block;
 *   - an INVOICE / ACT for the money, which lists what was charged, what was discounted, what was
 *     received and what is still owed — the document an accountant or a tax inspection reads.
 *
 * Both are produced from the SAME stored figures the booking carries. Nothing is recomputed from
 * today's rates: a document that disagrees with the amount charged is worse than no document, and
 * re-pricing last March's let with this year's season is exactly how that happens.
 *
 * Amounts are printed with the currency's own minor-unit precision and the grouping the locale
 * expects, from integer minor units — the document is the last place a rounding artefact should
 * appear.
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { wholeMonthsBetween } = require("../domain/booking/booking-policy.cjs");

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape everything that reaches the page: a guest name is user input and lands in a document. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

function formatMoney(minor, currency = "AZN") {
  const value = Number(minor || 0) / 100;
  return `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric" })
    .format(new Date(`${value}T00:00:00`));
}

/**
 * A document number that is stable across reprints.
 *
 * Deliberately DERIVED from the booking rather than taken from a counter: a sequence has to be
 * persisted, and a number that changes when a document is regenerated — or that two devices
 * disagree about — is worse than a slightly ugly one. It is unique (the booking's id is), it says
 * when the booking was taken, and it is short enough to write on a paper copy.
 */
function documentNumber(reservation) {
  const id = String(reservation?.id ?? "").replace(/-/g, "");
  const stamp = String(reservation?.created_at ?? "").slice(0, 10).replace(/-/g, "") || "00000000";
  return `${stamp}-${id.slice(0, 4).toUpperCase()}`;
}

/**
 * The account's own details, as the left-hand party of a document.
 *
 * The role is a parameter because the same rows read differently on the two documents: a lease has
 * a наймодатель, an invoice has an исполнитель, and printing the wrong one on a tax document is
 * the kind of detail an accountant returns.
 */
/**
 * How many whole calendar months a tenancy runs for.
 *
 * Derived from the dates rather than read from `rental_months`: that field is attached by the IPC
 * layer when it lists reservations, and a contract built from a single fetched row does not have
 * it. Reading the missing field produced a twelve-month lease that said "(0 мес.)".
 *
 * The stored breakdown is preferred when it has a month count, because that is the count the rent
 * was calculated from — but it is only ever equal to this one, and falling back to the dates keeps
 * a document printable when the breakdown is missing or unreadable.
 */
function tenancyMonths(reservation) {
  try {
    const breakdown = JSON.parse(reservation?.rate_breakdown || "{}") || {};
    if (Number(breakdown.months) > 0) return Number(breakdown.months);
  } catch {
    // Fall through to the dates.
  }
  if (reservation?.check_in_date && reservation?.check_out_date) {
    return wholeMonthsBetween(reservation.check_in_date, reservation.check_out_date);
  }
  return 0;
}

/** Meter readings a person can read: the stored JSON is for a program, not for a contract. */
function readingsLabel(raw) {
  try {
    const readings = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
    const entries = Object.entries(readings || {});
    if (!entries.length) return "";
    return entries
      .map(([name, value]) => `${escapeHtml(name)}: ${escapeHtml(String(value?.start ?? "—"))} → ${escapeHtml(String(value?.end ?? "—"))}`)
      .join("; ");
  } catch {
    // Unreadable readings are reference data: leaving them off the contract costs nothing, and a
    // JSON blob on a signed document costs the document its credibility.
    return "";
  }
}

function partyRows(role, requisites) {
  const row = (label, value) => (value
    ? `<div class="req-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
    : "");
  return [
    row(role, requisites?.lessorName),
    row("ИНН / VÖEN", requisites?.lessorTaxId),
    row("Адрес", requisites?.lessorAddress),
    row("Телефон", requisites?.lessorPhone),
  ].join("");
}

/**
 * The rows that need the full page width.
 *
 * An IBAN is 28 characters and has no spaces to break at, so in a half-width column the last
 * digit wraps onto a line of its own — which is exactly what it did.
 */
function wideRows(entries) {
  return entries
    .filter(([, value]) => value)
    .map(([label, value]) => `<div class="req-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
}

/** The priced lines of a booking: the working stored with the amount, or one line if there is none. */
function accommodationLines(reservation) {
  let breakdown = {};
  try {
    breakdown = JSON.parse(reservation?.rate_breakdown || "{}") || {};
  } catch {
    // An unreadable breakdown is not a reason to withhold the document: the amount is stored
    // separately and is what the guest actually pays.
    breakdown = {};
  }
  if (Array.isArray(breakdown.lines) && breakdown.lines.length) {
    return breakdown.lines.map((line) => ({
      label: line.label ? `${line.label}: ${line.nights} ноч.` : `${line.nights} ноч.`,
      amountMinor: line.amountMinor,
    }));
  }
  if (breakdown.months) {
    return [{ label: `Аренда за ${breakdown.months} мес.`, amountMinor: breakdown.grossMinor }];
  }
  const nights = Number(reservation?.nights_count || 0);
  return [{
    label: reservation?.booking_kind === "rental" ? "Аренда по договору" : `Проживание${nights ? `, ${nights} ноч.` : ""}`,
    amountMinor: reservation?.accommodation_minor || 0,
  }];
}

function discountOf(reservation) {
  try {
    const breakdown = JSON.parse(reservation?.rate_breakdown || "{}") || {};
    if (Number(breakdown.discountMinor) > 0) {
      return { amountMinor: breakdown.discountMinor, percent: Number(breakdown.discountPercent) || 0 };
    }
  } catch {
    // As above: no breakdown means no discount line, not a failed document.
  }
  return null;
}

/**
 * The faces a document is measured in, addressed the way the renderer will fetch them.
 *
 * These were the system's — `"Times New Roman", Georgia, serif` — which is a different font on
 * every machine: Times New Roman exists on macOS and on a Windows image with Office, and on a
 * stock Linux it does not exist at all, so Chromium substitutes another serif with different
 * advance widths. The same booking then broke its lines elsewhere, and `scripts/e2e-documents.mjs`
 * asserts a PAGE COUNT — so that assertion was really an assertion about the machine's fonts.
 *
 * Liberation Serif is metric-compatible with Times New Roman (same advances, the same 2048
 * units-per-em), which is why the pages keep the line breaks and the page count they already had
 * while no longer depending on an installed font. It ships in `build/fonts/`.
 *
 * The URL is absolute and built with `pathToFileURL`, because the document is written to a
 * TEMPORARY file and loaded from there: a relative URL would resolve against the temp directory
 * and find nothing. `pathToFileURL` is also what escapes the spaces and non-ASCII characters a
 * real install path contains — "Book program", `C:\Program Files`, a Cyrillic user name.
 *
 * `local()` is deliberately NOT listed before the file. A machine that already has some Liberation
 * Serif — an older 1.x, a distribution's rebuild — would then win over the shipped file, which is
 * the very machine-dependence this removes.
 */
const FONT_FACES = [
  { weight: 400, file: "LiberationSerif-Regular.ttf" },
  { weight: 700, file: "LiberationSerif-Bold.ttf" },
];

function fontFaceRules() {
  const directory = path.join(__dirname, "..", "..", "build", "fonts");
  return FONT_FACES.map(({ weight, file }) => `
    @font-face {
      font-family: "Liberation Serif";
      font-style: normal;
      font-weight: ${weight};
      src: url("${pathToFileURL(path.join(directory, file)).href}") format("truetype");
    }`).join("");
}

function styleSheet() {
  return `
    @page { size: A4; margin: 18mm 16mm; }${fontFaceRules()}
    * { box-sizing: border-box; }
    /* No fallback that can change the metrics: Georgia was one, and it is a wider face than the
       one Times New Roman resolved to. The trailing generic serif is a last resort for an install
       whose font files are missing, and it is the only case in which the machine decides. */
    body { margin: 0; color: #17211c; font: 11.5pt/1.5 "Liberation Serif", serif; }
    h1 { margin: 0 0 2mm; font-size: 16pt; text-align: center; }
    h2 { margin: 7mm 0 2mm; font-size: 12.5pt; }
    .meta { display: flex; justify-content: space-between; margin-bottom: 6mm; font-size: 10.5pt; color: #44514a; }
    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-bottom: 5mm; }
    /* A label column narrow enough that a value has room to breathe, and values that wrap by
       word rather than mid-word: the first version broke "Набиевых" across two lines and pushed
       the phone number under its own label. */
    .req-row { display: grid; grid-template-columns: 26mm 1fr; gap: 3mm; margin-bottom: 1mm; }
    .req-row dt { color: #44514a; }
    .req-row dd { overflow-wrap: break-word; }
    .party-wide { margin-top: 4mm; }
    .party-wide .req-row { grid-template-columns: 26mm 1fr; }
    .req-row dd { margin: 0; }
    dl { margin: 0; }
    table { width: 100%; border-collapse: collapse; margin: 3mm 0; }
    th, td { border: 0.4pt solid #6d7a73; padding: 2mm 2.5mm; text-align: left; vertical-align: top; }
    th { background: #eef3f0; font-size: 10pt; }
    td.num, th.num { text-align: right; white-space: nowrap; }
    tfoot td { font-weight: 700; }
    .terms { margin: 3mm 0 0; padding-left: 6mm; }
    .terms li { margin-bottom: 1.5mm; }
    .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 12mm; }
    .signature-line { border-top: 0.4pt solid #17211c; padding-top: 1.5mm; font-size: 10pt; color: #44514a; }
    .note { margin-top: 6mm; font-size: 10pt; color: #44514a; }
    .filled { min-height: 4mm; }
  `;
}

function documentShell({ title, body }) {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${styleSheet()}</style></head>
<body>${body}</body></html>`;
}

/**
 * A rental agreement, ready to be printed and signed.
 *
 * The clauses are the ones a residential let actually turns on: the term, the rent and when it is
 * due, the deposit, and what happens to the utilities. They are written as plain sentences rather
 * than as a legal template, because this document is produced by an owner letting a flat and not
 * by a lawyer: a form nobody reads is worse than four lines everybody understands.
 */
function buildContractHtml({ reservation, unit, place, requisites, generatedAt }) {
  const monthly = Number(reservation.monthly_rate_minor || 0);
  const months = tenancyMonths(reservation);
  const total = Number(reservation.accommodation_minor || 0);
  const deposit = Number(reservation.deposit_minor || 0);
  const readings = readingsLabel(reservation.meter_readings);
  const city = requisites?.documentCity || "Баку";
  const day = formatDate(generatedAt);

  const body = `
    <h1>Договор найма жилого помещения № ${escapeHtml(documentNumber(reservation))}</h1>
    <div class="meta"><span>${escapeHtml(city)}</span><span>${escapeHtml(day)}</span></div>

    <div class="parties">
      <dl>${partyRows("Наймодатель", requisites) || '<div class="req-row"><dt>Наймодатель</dt><dd class="filled"></dd></div>'}</dl>
      <dl>
        <div class="req-row"><dt>Наниматель</dt><dd>${escapeHtml(reservation.guest_name)}</dd></div>
        ${reservation.guest_phone ? `<div class="req-row"><dt>Телефон</dt><dd>${escapeHtml(reservation.guest_phone)}</dd></div>` : ""}
        ${reservation.guest_email ? `<div class="req-row"><dt>Email</dt><dd>${escapeHtml(reservation.guest_email)}</dd></div>` : ""}
        <div class="req-row"><dt>Проживающих</dt><dd>${escapeHtml(String(reservation.adults || 1))} взр.${Number(reservation.children) > 0 ? `, ${escapeHtml(String(reservation.children))} дет.` : ""}</dd></div>
      </dl>
    </div>
    <dl class="party-wide">${wideRows([
      ["Объект", `${unit?.name || "—"}${place?.name ? ` (${place.name})` : ""}${unit?.location ? `, ${unit.location}` : ""}`],
      ["Срок найма", `${formatDate(reservation.check_in_date)} — ${formatDate(reservation.check_out_date)}`],
      ["Банковские реквизиты", requisites?.bankDetails],
    ])}</dl>

    <h2>1. Предмет договора</h2>
    <p>Наймодатель предоставляет во владение и пользование жилое помещение
    «${escapeHtml(unit?.name || "—")}»${place?.name ? ` (${escapeHtml(place.name)})` : ""}${
      unit?.location ? `, расположенное по адресу: ${escapeHtml(unit.location)}` : ""}, а Наниматель принимает его и оплачивает пользование на условиях настоящего договора.</p>

    <h2>2. Срок</h2>
    <p>Срок найма — с ${escapeHtml(formatDate(reservation.check_in_date))} по ${escapeHtml(formatDate(reservation.check_out_date))}
    (${escapeHtml(String(months))} мес.). Передача помещения производится в день начала срока, возврат — в день окончания.</p>

    <h2>3. Плата за пользование</h2>
    <table>
      <thead><tr><th>Наименование</th><th class="num">Сумма</th></tr></thead>
      <tbody>
        <tr><td>Плата за пользование за ${escapeHtml(String(months))} мес. по ${escapeHtml(formatMoney(monthly, unit?.currency))} в месяц</td><td class="num">${escapeHtml(formatMoney(total, unit?.currency))}</td></tr>
        ${deposit > 0 ? `<tr><td>Обеспечительный платёж (возвратный депозит)</td><td class="num">${escapeHtml(formatMoney(deposit, unit?.currency))}</td></tr>` : ""}
      </tbody>
      <tfoot><tr><td>Итого к оплате по договору</td><td class="num">${escapeHtml(formatMoney(total + deposit, unit?.currency))}</td></tr></tfoot>
    </table>
    ${readings ? `<p>Показания счётчиков на дату передачи: ${readings}.</p>` : ""}

    <h2>4. Порядок расчётов</h2>
    <ul class="terms">
      <li>Плата вносится ежемесячно, не позднее 5-го числа оплачиваемого месяца, если стороны не договорились об ином.</li>
      <li>Обеспечительный платёж возвращается при возврате помещения, за вычетом стоимости повреждений и задолженности.</li>
      <li>Коммунальные платежи оплачиваются Нанимателем по показаниям счётчиков, если иное не согласовано сторонами.</li>
    </ul>

    <h2>5. Прочие условия</h2>
    <ul class="terms">
      <li>Наниматель использует помещение только для проживания.</li>
      <li>Досрочное расторжение допускается по письменному соглашению сторон; расчёт производится за фактически истёкшие целые месяцы.</li>
      <li>Настоящий договор составлен в двух экземплярах, имеющих одинаковую силу, по одному для каждой стороны.</li>
    </ul>
    ${reservation.notes ? `<p class="note">Примечания: ${escapeHtml(reservation.notes)}</p>` : ""}

    <div class="signatures">
      <div><div class="signature-line">Наймодатель${requisites?.signatoryName ? `: ${escapeHtml(requisites.signatoryName)}` : ""}<br>подпись / дата</div></div>
      <div><div class="signature-line">Наниматель: ${escapeHtml(reservation.guest_name)}<br>подпись / дата</div></div>
    </div>`;

  return documentShell({ title: `Договор № ${documentNumber(reservation)}`, body });
}

/**
 * An invoice and act of rendered services, for the money.
 *
 * The breakdown comes from the booking's stored `rate_breakdown`, so the season rates and the
 * discount that produced the amount are the ones that applied when it was taken — not the ones
 * the unit carries today.
 */
function buildInvoiceHtml({ reservation, unit, place, requisites, generatedAt }) {
  const currency = unit?.currency || reservation.currency || "AZN";
  const lines = accommodationLines(reservation);
  const discount = discountOf(reservation);
  const meals = Number(reservation.services_minor || 0);
  const deposit = Number(reservation.deposit_minor || 0);
  const prepaid = Number(reservation.prepaid_minor || 0);
  const total = Number(reservation.total_minor || 0);
  const balance = Math.max(0, total - prepaid);
  const refund = Math.max(0, prepaid - total);
  const number = documentNumber(reservation);

  const rows = [
    ...lines.map((line) => `<tr><td>${escapeHtml(line.label)}</td><td class="num">${escapeHtml(formatMoney(line.amountMinor, currency))}</td></tr>`),
    ...(discount ? [`<tr><td>Скидка${discount.percent ? ` ${escapeHtml(String(discount.percent))}%` : ""}</td><td class="num">−${escapeHtml(formatMoney(discount.amountMinor, currency))}</td></tr>`] : []),
    ...(meals > 0 ? [`<tr><td>Питание</td><td class="num">${escapeHtml(formatMoney(meals, currency))}</td></tr>`] : []),
  ].join("");

  const body = `
    <h1>Счёт и акт № ${escapeHtml(number)}</h1>
    <div class="meta"><span>${escapeHtml(requisites?.documentCity || "Баку")}</span><span>${escapeHtml(formatDate(generatedAt))}</span></div>

    <div class="parties">
      <dl>${partyRows("Исполнитель", requisites) || '<div class="req-row"><dt>Исполнитель</dt><dd class="filled"></dd></div>'}</dl>
      <dl>
        <div class="req-row"><dt>Заказчик</dt><dd>${escapeHtml(reservation.guest_name)}</dd></div>
        ${reservation.guest_phone ? `<div class="req-row"><dt>Телефон</dt><dd>${escapeHtml(reservation.guest_phone)}</dd></div>` : ""}
      </dl>
    </div>
    <dl class="party-wide">${wideRows([
      ["Объект", `${unit?.name || "—"}${place?.name ? ` (${place.name})` : ""}${unit?.location ? `, ${unit.location}` : ""}`],
      ["Период", `${formatDate(reservation.check_in_date)} — ${formatDate(reservation.actual_check_out_date || reservation.check_out_date)}`],
      ["Банковские реквизиты", requisites?.bankDetails],
    ])}</dl>

    <table>
      <thead><tr><th>Наименование услуги</th><th class="num">Сумма</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td>Итого начислено</td><td class="num">${escapeHtml(formatMoney(total, currency))}</td></tr>
        ${prepaid > 0 ? `<tr><td>Получено</td><td class="num">${escapeHtml(formatMoney(prepaid, currency))}</td></tr>` : ""}
        <tr><td>${refund > 0 ? "К возврату" : "К оплате"}</td><td class="num">${escapeHtml(formatMoney(refund > 0 ? refund : balance, currency))}</td></tr>
      </tfoot>
    </table>
    ${deposit > 0 ? `<p class="note">Обеспечительный платёж ${escapeHtml(formatMoney(deposit, currency))} принят отдельно и не является выручкой; подлежит возврату.</p>` : ""}
    <p>Услуги оказаны в полном объёме и в срок. Претензий по объёму и качеству Заказчик не имеет.</p>

    <div class="signatures">
      <div><div class="signature-line">Исполнитель${requisites?.signatoryName ? `: ${escapeHtml(requisites.signatoryName)}` : ""}<br>подпись / дата</div></div>
      <div><div class="signature-line">Заказчик: ${escapeHtml(reservation.guest_name)}<br>подпись / дата</div></div>
    </div>`;

  return documentShell({ title: `Счёт № ${number}`, body });
}

const DOCUMENT_KINDS = {
  contract: { label: "Договор найма", build: buildContractHtml, suffix: "dogovor" },
  invoice: { label: "Счёт и акт", build: buildInvoiceHtml, suffix: "schet" },
};

/** A file name a person can find again in a folder of PDFs. */
function documentFileName(kind, reservation) {
  const spec = DOCUMENT_KINDS[kind] || DOCUMENT_KINDS.invoice;
  const guest = String(reservation?.guest_name || "booking")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "booking";
  return `${spec.suffix}-${documentNumber(reservation)}-${guest}.pdf`;
}

module.exports = {
  DOCUMENT_KINDS,
  buildContractHtml,
  buildInvoiceHtml,
  documentFileName,
  documentNumber,
  escapeHtml,
  formatMoney,
};
