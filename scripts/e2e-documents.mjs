// Paperwork: a contract and an invoice, produced from the real app as real PDF files.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-documents.mjs
//
// tests/documents.test.cjs asserts what the two documents SAY, from pure functions. What it
// cannot show is that the path works at all: the document is built in the main process from stored
// rows, rendered by an offscreen browser window, and written to disk. Every one of those steps is
// a place where a button can appear to work and produce nothing.

import fs from "node:fs";
import {connect, freshStart, reporter, wait} from "./e2e-lib.mjs";

let app = await connect();
const { check, finish } = reporter("Documents");

const email = `documents-${Date.now()}@example.test`;
app = await freshStart(app);
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await app.evaluate(`document.getElementById('loginEmailForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(3000);
const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g,'') : '';`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await app.evaluate(`document.getElementById('loginCodeForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(2500);
}

// --- The details a document has to carry ---------------------------------
const saved = await app.evaluate(`
  const bridge = window.domBook;
  return bridge.system.setDocumentRequisites({
    lessorName: 'ИП Мамедов Р.А.',
    lessorTaxId: '1234567890',
    lessorAddress: 'Баку, ул. Низами 1',
    lessorPhone: '+994 50 111 22 33',
    bankDetails: 'Kapital Bank, AZ21NABZ00000000137010001944',
    signatoryName: 'Мамедов Р.А.',
    documentCity: 'Баку',
  });
`);
check(saved.ok && saved.data.lessorTaxId === "1234567890",
  "the requisites an accountant needs are stored", JSON.stringify(saved.error ?? ""));

// --- A tenancy to write a contract about ----------------------------------
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const setup = await app.evaluate(`
  const bridge = window.domBook;
  const stamp = Date.now();
  const unit = await bridge.properties.create({
    placeId: null, kind: 'house', name: 'Договорной дом ' + stamp, location: 'Габала',
    capacity: 6, currency: 'AZN', basePriceMinor: 20000, monthlyRateMinor: 400000,
    depositMinor: 400000, checkInTime: '15:00', checkOutTime: '11:00', notes: '', status: 'active',
    rateRules: { tenancyDiscounts: [{ minimumMonths: 12, percent: 10 }] },
  });
  if (!unit.ok) return { error: unit.error };
  const booking = await bridge.reservations.create({
    bookingKind: 'rental', propertyId: unit.data.id,
    checkInDate: ${JSON.stringify(day(10))}, checkOutDate: ${JSON.stringify(day(375))},
    guestName: 'Семья Набиевых', guestPhone: '+994 12 493 00 11', guestEmail: 'nabiev@example.test',
    adults: 3, children: 2, prepaidMinor: 400000, depositMinor: 400000, depositStatus: 'received',
    status: 'confirmed', notes: '', mealItems: [], meterReadings: { electricity: { start: 1200, end: 1340 } },
  });
  if (!booking.ok) return { error: booking.error };
  await refreshCore();
  // rental_months is computed by the main process for the LIST, not attached to a created row,
  // so the month count is read back the way the rentals page reads it.
  // A second, free unit for the nightly booking further down: the tenancy above holds its own
  // unit for a year, and a stay inside the booking window could only overlap it.
  const spare = await bridge.properties.create({
    placeId: null, kind: 'cottage', name: 'Ночной дом ' + stamp, location: 'Габала',
    capacity: 4, currency: 'AZN', basePriceMinor: 24000, monthlyRateMinor: 0,
    depositMinor: 0, checkInTime: '15:00', checkOutTime: '11:00', notes: '', status: 'active',
  });
  const list = await bridge.reservations.list();
  const stored = list.data.find((r) => r.id === booking.data.id);
  return {
    unitId: unit.data.id,
    spareId: spare.data?.id,
    bookingId: booking.data.id,
    months: stored?.rental_months,
    total: booking.data.accommodation_minor,
  };
`);
check(Boolean(setup.bookingId), "a twelve-month tenancy exists to write about", JSON.stringify(setup.error ?? ""));
if (!setup.bookingId) {
  // Stop here rather than crashing three checks later on an undefined document: a failure that
  // says "the booking was not created" is worth more than a stack trace about `includes`.
  finish();
  console.log("DOCUMENTS FAILED (setup)");
  app.close();
  process.exit(1);
}
check(setup.months === 12 && setup.total === 4320000,
  "the year is discounted in the booking the document will describe", `${setup.months} мес., ${setup.total}`);

// --- The document text ----------------------------------------------------
const html = await app.evaluate(`
  const bridge = window.domBook;
  const result = await bridge.documents.html({ reservationId: ${JSON.stringify(setup.bookingId)}, kind: 'contract' });
  return result.data;
`);
check(typeof html === "string" && html.includes("Договор найма жилого помещения"),
  "the contract is built from the stored booking");
check(html.includes("ИП Мамедов Р.А.") && html.includes("1234567890"),
  "the contract prints the landlord's requisites");
check(html.includes("Семья Набиевых") && html.includes("подпись / дата"),
  "the contract names the tenant and leaves room for signatures");
check(/4\s?320\u00a0000,00 AZN|43\s?200,00 AZN/.test(html),
  "the contract states the discounted sum, not the undiscounted one");

// --- The files ------------------------------------------------------------
const contract = await app.evaluate(`
  const bridge = window.domBook;
  return bridge.documents.create({ reservationId: ${JSON.stringify(setup.bookingId)}, kind: 'contract' });
`);
check(contract.ok && contract.data.path, "the contract is written to disk", JSON.stringify(contract.error ?? contract.data?.path));
const contractBytes = contract.ok ? fs.statSync(contract.data.path).size : 0;
const contractHead = contract.ok ? fs.readFileSync(contract.data.path).subarray(0, 5).toString("latin1") : "";
check(contractHead === "%PDF-", "the contract file is a PDF", contractHead);
check(contractBytes > 3000, "the contract is not an empty page", `${contractBytes} bytes`);
// A page count, because a contract that lost its second page is still a valid PDF that opens
// normally: the clauses and the signature block are simply not in it. This is the check that
// caught exactly that, after `preferCSSPageSize` truncated every document to one page.
const pageCount = (file) => (fs.readFileSync(file, "latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
check(pageCount(contract.data.path) >= 2,
  "every page of the contract is in the file, signature block included",
  `${pageCount(contract.data.path)} page(s)`);
check(/\.pdf$/.test(contract.data.fileName) && /Договорной|dogovor/.test(contract.data.fileName),
  "the file is named so it can be found again", contract.data.fileName);

const invoice = await app.evaluate(`
  const bridge = window.domBook;
  return bridge.documents.create({ reservationId: ${JSON.stringify(setup.bookingId)}, kind: 'invoice' });
`);
check(invoice.ok && fs.readFileSync(invoice.data.path).subarray(0, 5).toString("latin1") === "%PDF-",
  "the invoice is written to disk as a PDF", JSON.stringify(invoice.error ?? ""));
check(invoice.data.path !== contract.data.path, "the two documents are separate files");
// The offscreen renderer must not be left behind: a window per document would accumulate for the
// life of the session, which nobody would notice until the app slowed down.
const windows = await app.evaluate(`return window.__documentWindowCount ?? 'unknown';`);
check(windows === "unknown" || windows === 0, "no leftover renderer window", String(windows));

// --- A stay gets an invoice, not a contract -------------------------------
const stayCreated = await app.evaluate(`
  const bridge = window.domBook;
  const created = await bridge.reservations.create({
    bookingKind: 'stay', propertyId: ${JSON.stringify(setup.spareId)},
    checkInDate: ${JSON.stringify(day(2))}, checkOutDate: ${JSON.stringify(day(5))},
    guestName: 'Айгюн Мамедова', guestPhone: '', guestEmail: '', adults: 2, children: 0,
    prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', status: 'confirmed', notes: '', mealItems: [],
  });
  await refreshCore();
  return { ok: created.ok, error: created.error };
`);
check(stayCreated.ok, "a nightly booking exists for the invoice-only case", JSON.stringify(stayCreated.error ?? ""));
const stayDoc = await app.evaluate(`
  const bridge = window.domBook;
  const list = await bridge.reservations.list();
  const stay = list.data.find((r) => r.guest_name === 'Айгюн Мамедова');
  await openDocumentsDialog(stay.id);
  return {
    contractHidden: document.getElementById('documentContract').hidden,
    invoiceShown: !document.getElementById('documentInvoice').hidden,
    intro: document.getElementById('documentsIntro').textContent,
  };
`);
check(stayDoc.contractHidden, "a nightly booking is not offered a tenancy agreement");
check(stayDoc.invoiceShown, "a nightly booking is still offered an invoice");
await app.evaluate(`document.getElementById('documentsDialog').close(); return 'ok';`);

const ok = finish();
console.log(ok ? "DOCUMENTS OK" : "DOCUMENTS FAILED");
app.close();
process.exit(ok ? 0 : 1);
