// The paperwork: what a contract and an invoice actually say.
//
// These are pure functions over rows, so the wording and the arithmetic are asserted here rather
// than by producing a PDF and reading it back. The one thing a text assertion cannot cover — that
// the file opens and is a PDF — belongs to scripts/e2e-documents.mjs, which generates one.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const {
  DOCUMENT_KINDS,
  buildContractHtml,
  buildInvoiceHtml,
  documentFileName,
  documentNumber,
  escapeHtml,
  formatMoney,
} = require("../src/main/documents.cjs");

const unit = {
  name: "Коттедж «Сосны»",
  currency: "AZN",
  location: "Габала, Нохургышлаг",
  monthly_rate_minor: 400000,
};

const place = { name: "Дом отдыха «Лесная долина»" };

const requisites = {
  lessorName: "ИП Мамедов Р.А.",
  lessorTaxId: "1234567890",
  lessorAddress: "Баку, ул. Низами 1",
  lessorPhone: "+994 50 111 22 33",
  bankDetails: "Kapital Bank, AZ21NABZ00000000137010001944",
  signatoryName: "Мамедов Р.А.",
  documentCity: "Баку",
};

function tenancy(overrides = {}) {
  return {
    id: "8f3a1c02-1111-2222-3333-444455556666",
    created_at: "2026-10-15T09:00:00.000Z",
    booking_kind: "rental",
    guest_name: "Семья Набиевых",
    guest_phone: "+994 12 493 00 11",
    guest_email: "nabiev@example.test",
    check_in_date: "2026-10-25",
    check_out_date: "2027-02-25",
    actual_check_out_date: null,
    adults: 3,
    children: 2,
    monthly_rate_minor: 400000,
    rental_months: 4,
    accommodation_minor: 1600000,
    services_minor: 0,
    total_minor: 1600000,
    prepaid_minor: 400000,
    deposit_minor: 400000,
    meter_readings: JSON.stringify({ electricity: { start: 1200, end: 1340 } }),
    rate_breakdown: JSON.stringify({
      kind: "rental", months: 4, monthlyRateMinor: 400000, effectiveMonthlyMinor: 400000,
      grossMinor: 1600000, discountPercent: 0, discountMinor: 0, totalMinor: 1600000,
    }),
    notes: "",
    ...overrides,
  };
}

function stay(overrides = {}) {
  return {
    id: "a1b2c3d4-1111-2222-3333-444455556666",
    created_at: "2026-10-15T09:00:00.000Z",
    booking_kind: "stay",
    guest_name: "Айгюн Мамедова",
    guest_phone: "+994 50 123 45 67",
    check_in_date: "2026-12-23",
    check_out_date: "2026-12-28",
    actual_check_out_date: null,
    adults: 2,
    children: 1,
    accommodation_minor: 192000,
    services_minor: 21000,
    total_minor: 213000,
    prepaid_minor: 50000,
    deposit_minor: 30000,
    meter_readings: "{}",
    rate_breakdown: JSON.stringify({
      kind: "stay",
      nights: 5,
      lines: [
        { label: "", nightlyRateMinor: 24000, nights: 2, amountMinor: 48000 },
        { label: "Новый год", nightlyRateMinor: 48000, nights: 3, amountMinor: 144000 },
      ],
      grossMinor: 192000,
      discountPercent: 0,
      discountMinor: 0,
      totalMinor: 192000,
    }),
    notes: "",
    ...overrides,
  };
}

test("договор называет стороны, срок, плату и депозит", () => {
  const html = buildContractHtml({ reservation: tenancy(), unit, place, requisites, generatedAt: "2026-10-15" });
  assert.match(html, /Договор найма жилого помещения/);
  assert.match(html, /ИП Мамедов Р\.А\./);
  assert.match(html, /1234567890/);
  assert.match(html, /Семья Набиевых/);
  assert.match(html, /Коттедж «Сосны»/);
  assert.match(html, /Дом отдыха «Лесная долина»/);
  assert.match(html, /25 октября 2026/);
  assert.match(html, /4 мес\./);
  assert.match(html, new RegExp(formatMoney(1600000).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\u00a0/g, "\\s")));
  assert.match(html, /подпись \/ дата/);
});

test("договор перечисляет депозит отдельной строкой и складывает только итог к оплате", () => {
  const html = buildContractHtml({ reservation: tenancy(), unit, place, requisites, generatedAt: "2026-10-15" });
  assert.match(html, /Обеспечительный платёж \(возвратный депозит\)/);
  // 16 000 rent + 4 000 deposit. A deposit is not revenue, so it is a separate line — but it IS
  // money the tenant hands over, so the total to pay includes it.
  assert.match(html, new RegExp(formatMoney(2000000).replace(/\u00a0/g, "\\s")));
});

test("счёт показывает сезоны и скидку, из которых сложилась сумма", () => {
  const html = buildInvoiceHtml({ reservation: stay(), unit, place, requisites, generatedAt: "2026-10-15" });
  assert.match(html, /Новый год: 3 ноч\./);
  assert.match(html, /2 ноч\./);
  assert.match(html, /Питание/);
  assert.match(html, /Итого начислено/);
});

test("счёт печатает остаток к оплате, а переплату — как возврат", () => {
  const owing = buildInvoiceHtml({ reservation: stay(), unit, place, requisites, generatedAt: "2026-10-15" });
  assert.match(owing, /К оплате/);
  assert.match(owing, new RegExp(formatMoney(163000).replace(/\u00a0/g, "\\s")));

  // Prepaid more than the bill: the document must ask for nothing and say what is owed back.
  const refund = buildInvoiceHtml({
    reservation: stay({ prepaid_minor: 300000 }),
    unit, place, requisites, generatedAt: "2026-10-15",
  });
  assert.match(refund, /К возврату/);
  assert.match(refund, new RegExp(formatMoney(87000).replace(/\u00a0/g, "\\s")));
  assert.doesNotMatch(refund, /К оплате/);
});

test("депозит в счёте не становится выручкой", () => {
  const html = buildInvoiceHtml({ reservation: stay(), unit, place, requisites, generatedAt: "2026-10-15" });
  assert.match(html, /принят отдельно и не является выручкой/);
  assert.doesNotMatch(html, /Итого начислено<\/td><td class="num">243 000,00/);
});

test("сумма берётся из брони, а не пересчитывается по сегодняшним ценам", () => {
  // The unit's rate has since doubled. The document must still state what was charged: an invoice
  // that re-prices an old booking is the one failure a tax document cannot have.
  const html = buildInvoiceHtml({
    reservation: stay(),
    unit: { ...unit, base_price_minor: 48000 },
    place, requisites, generatedAt: "2026-10-15",
  });
  const money = (minor) => new RegExp(formatMoney(minor).replace(/\u00a0/g, "\\s"));
  // The stored lines: two nights at the old base rate and three at the season rate.
  assert.match(html, money(144000));
  assert.match(html, money(48000));
  // What the doubled rate would produce, if the document were built from today's prices instead.
  assert.doesNotMatch(html, money(240000));
  assert.doesNotMatch(html, money(96000));
});

test("имя гостя не может принести разметку в документ", () => {
  const nasty = stay({ guest_name: '<img src=x onerror="alert(1)">Ольга' });
  const html = buildInvoiceHtml({ reservation: nasty, unit, place, requisites, generatedAt: "2026-10-15" });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("сломанная разбивка не мешает выпустить документ", () => {
  // The amount is stored separately and is what the guest pays. A breakdown that cannot be read
  // costs the season lines, not the invoice.
  const html = buildInvoiceHtml({
    reservation: stay({ rate_breakdown: "{ not json" }),
    unit, place, requisites, generatedAt: "2026-10-15",
  });
  assert.match(html, /Проживание/);
  assert.match(html, new RegExp(formatMoney(192000).replace(/\u00a0/g, "\\s")));
});

test("номер документа не меняется при повторной печати", () => {
  const first = documentNumber(tenancy());
  const second = documentNumber(tenancy({ guest_name: "Другой гость", total_minor: 1 }));
  assert.equal(first, second);
  // Derived from the id and the date it was taken, so two devices agree without a counter.
  assert.equal(first, "20261015-8F3A");
  assert.notEqual(first, documentNumber(stay()));
});

test("имя файла можно найти в папке с десятком других", () => {
  assert.equal(documentFileName("contract", tenancy()), "dogovor-20261015-8F3A-Семья-Набиевых.pdf");
  assert.equal(documentFileName("invoice", stay()), "schet-20261015-A1B2-Айгюн-Мамедова.pdf");
  // A guest name that is all punctuation must not produce a file called "-.pdf".
  assert.match(documentFileName("invoice", stay({ guest_name: "***" })), /^schet-20261015-A1B2-booking\.pdf$/);
});

test("суммы печатаются в минорных единицах без потерь", () => {
  // The thousands separator is a NON-BREAKING space, and that is deliberate: a currency figure
  // that wraps between "16" and "000,00" is a number nobody can read. The assertions below say
  // "the separator is not an ordinary space" rather than naming the character, so the test states
  // the property instead of the code point.
  assert.equal(formatMoney(0), "0,00 AZN");
  assert.equal(formatMoney(5), "0,05 AZN");
  assert.equal(formatMoney(1600000).replace(/\u00a0/g, " "), "16 000,00 AZN");
  assert.match(formatMoney(1600000), /\u00a0/);
  assert.equal(formatMoney(123456789, "USD").replace(/\u00a0/g, " "), "1 234 567,89 USD");
  // Minor units survive: two decimals, never a float artefact.
  assert.equal(formatMoney(1), "0,01 AZN");
  assert.equal(formatMoney(999), "9,99 AZN");
});

test("экранирование покрывает всё, что попадает на страницу", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  assert.equal(escapeHtml(null), "");
});

test("оба вида документа зарегистрированы и собираются", () => {
  assert.deepEqual(Object.keys(DOCUMENT_KINDS).sort(), ["contract", "invoice"]);
  for (const [kind, spec] of Object.entries(DOCUMENT_KINDS)) {
    const html = spec.build({ reservation: kind === "contract" ? tenancy() : stay(), unit, place, requisites, generatedAt: "2026-10-15" });
    assert.match(html, /^<!doctype html>/, `${kind} должен быть полным документом`);
    assert.match(html, /@page \{ size: A4/, `${kind} должен задавать формат страницы`);
  }
});

/** The `src:` URLs the stylesheet asks the renderer to fetch. */
function fontUrls(html) {
  return [...html.matchAll(/src: url\("([^"]+)"\)/g)].map((match) => match[1]);
}

test("документ печатается встроенным шрифтом, а не тем, что стоит на машине", () => {
  // Times New Roman, which the stack used to name, does not exist on a stock Linux; Chromium then
  // substitutes a serif with different advance widths, so the same booking broke its lines
  // elsewhere and could change page count — and scripts/e2e-documents.mjs asserts a page count,
  // which made that assertion an assertion about the machine's fonts.
  //
  // Asserted on the STACK rather than on the whole page, because the stylesheet explains in a
  // comment which family it replaced, and a substring check over the document would find that
  // explanation and fail on it.
  for (const kind of Object.keys(DOCUMENT_KINDS)) {
    const html = DOCUMENT_KINDS[kind].build({ reservation: kind === "contract" ? tenancy() : stay(), unit, place, requisites, generatedAt: "2026-10-15" });
    assert.match(html, /font-family: "Liberation Serif"/, `${kind} должен объявлять встроенное семейство`);
    const stack = /font: [\d.]+pt\/[\d.]+ ([^;]+);/.exec(html)?.[1];
    assert.equal(stack, `"Liberation Serif", serif`,
      `${kind} должен печататься встроенным семейством, а последним — только общий serif`);
  }
});

test("шрифт документа лежит в поставке, а не только на машине разработчика", () => {
  // The URL is absolute and points into the repository, so a renamed or missing file is the one
  // failure the stylesheet cannot show: the page quietly falls back to a system serif, which is
  // the machine-dependence this replaced. Resolving the URL is what catches it.
  const urls = fontUrls(buildContractHtml({ reservation: tenancy(), unit, place, requisites, generatedAt: "2026-10-15" }));
  assert.equal(urls.length, 2, "нужны Regular и Bold — ими набраны и текст, и заголовки");
  assert.deepEqual(urls.map((url) => path.basename(fileURLToPath(url))).sort(),
    ["LiberationSerif-Bold.ttf", "LiberationSerif-Regular.ttf"]);
  for (const url of urls) {
    const file = fileURLToPath(url);
    assert.ok(fs.existsSync(file), `${file} должен существовать`);
    // A stub or a truncated download would satisfy `exists` and still render nothing.
    assert.ok(fs.statSync(file).size > 100000, `${file} должен быть настоящим шрифтом`);
  }
  // The OFL requires the licence to travel with the files it covers.
  assert.ok(fs.existsSync(path.join(path.dirname(fileURLToPath(urls[0])), "LICENSE.txt")));
});

test("файлы шрифта попадают в установщик", () => {
  // `build.files` is an ALLOWLIST, and it did not list build/fonts: the packaged application would
  // have shipped without the font and printed with whatever serif the user's machine happens to
  // have. A checkout cannot show that — the file is on disk either way.
  const { files } = require("../package.json").build;
  assert.ok(files.some((pattern) => /^build\/fonts\//.test(pattern)),
    `build.files должен включать build/fonts, а в нём: ${JSON.stringify(files)}`);
});
