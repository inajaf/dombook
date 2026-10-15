/**
 * Everything the page asks the outside world for.
 *
 * In the desktop app `window.domBook` is the preload bridge: the renderer is sandboxed and every
 * call crosses IPC, where the main process checks the session. A browser has no bridge, so
 * `createBrowserDemoApi` answers from memory — a demo, not the product.
 */

export const api = window.domBook || createBrowserDemoApi();

export async function unwrap(promise) {
  const result = await promise;
  if (!result?.ok) throw new Error(result?.error || "Операция не выполнена");
  return result.data;
}

/**
 * A short message, optionally with one thing to do about it.
 *
 * The action exists for the case that produced it: a generated document announced itself and then
 * left the owner to find `~/Library/Application Support` — a directory Finder hides by default —
 * to look at the file they had just made. A message that says "the document is ready" without a
 * way to open it is only half an answer.
 */

function createBrowserDemoApi() {
  const storageKey = "dombook.web.v1";
  let interfaceLanguage = "ru";
  let places = [
    { id: "1", name: "Дом отдыха «Лесная долина»", address: "Габала", has_food_service: 1, status: "active", notes: "", active_unit_count: 2, total_unit_count: 2 },
  ];
  let properties = [
    { id: "1", place_id: "1", place_name: "Дом отдыха «Лесная долина»", place_address: "Габала", kind: "cottage", name: "Коттедж «Сосны»", location: "", capacity: 6, base_price_minor: 24000, deposit_minor: 30000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 1 },
    { id: "2", place_id: "1", place_name: "Дом отдыха «Лесная долина»", place_address: "Габала", kind: "cottage", name: "Коттедж «У озера»", location: "", capacity: 8, base_price_minor: 32000, deposit_minor: 40000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 0 },
    { id: "3", place_id: null, place_name: null, place_address: null, kind: "house", name: "Отдельный дом в Шеки", location: "Шеки", capacity: 3, base_price_minor: 17000, deposit_minor: 20000, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", notes: "", status: "active", reservation_count: 0 },
  ];
  let reservations = [];
  let backups = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved) {
      if (Array.isArray(saved.places)) places = normalizeIds(saved.places);
      if (Array.isArray(saved.properties)) properties = normalizeIds(saved.properties);
      if (Array.isArray(saved.reservations)) reservations = normalizeIds(saved.reservations);
      if (Array.isArray(saved.backups)) backups = saved.backups;
      if (["ru", "az", "en"].includes(saved.language)) interfaceLanguage = saved.language;
    }
  } catch (error) {
    console.warn("RentKeeper web storage could not be restored", error);
  }
  const response = (data) => Promise.resolve({ ok: true, data });
  const error = (message) => Promise.resolve({ ok: false, error: message });
  let requisites = {};
  const documentPreviewHtml = () => "<!doctype html><p>Документ формируется в приложении для компьютера.</p>";
  const idOf = (value) => (value === null || value === undefined ? null : String(value));
  const findById = (list, id, key = "id") => list.find((item) => idOf(item[key]) === idOf(id));
  const normalizeIds = (list, keys = ["id", "place_id", "property_id", "reservation_id"]) => (list || []).map((item) => {
    const copy = { ...item };
    keys.forEach((key) => { if (copy[key] !== null && copy[key] !== undefined) copy[key] = String(copy[key]); });
    return copy;
  });
  const persist = () => localStorage.setItem(storageKey, JSON.stringify({
    version: 1,
    language: interfaceLanguage,
    places,
    properties,
    reservations,
    backups,
  }));
  const persistedResponse = (data) => {
    persist();
    return response(data);
  };
  const exportBackup = () => {
    const createdAt = new Date();
    const file = `rentkeeper-web-${createdAt.toISOString().replaceAll(":", "-")}.json`;
    const payload = JSON.stringify({ version: 1, exportedAt: createdAt.toISOString(), places, properties, reservations }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const backup = { file, size: blob.size, createdAt: createdAt.toISOString() };
    backups = [backup, ...backups].slice(0, 20);
    return persistedResponse(backup);
  };
  const list = () => reservations.map((item) => {
    const property = findById(properties, item.property_id);
    return { ...item, property_name: property?.name || "—", place_name: property?.place_name || null, currency: "AZN", balance_minor: Math.max(item.total_minor - item.prepaid_minor, 0), refund_due_minor: Math.max(item.prepaid_minor - item.total_minor, 0) };
  });
  const demoReservation = (data, previous = null) => {
    const property = findById(properties, data.propertyId);
    const place = findById(places, property?.place_id);
    const nights = nightsBetween(data.checkInDate, data.checkOutDate);
    const nightlyRate = previous?.nightly_rate_minor || property.base_price_minor;
    const meals = place?.has_food_service
      ? (data.mealItems || []).filter((item) => Number(item.amountMinor) > 0)
      : [];
    const servicesMinor = meals.reduce((sum, item) => sum + Number(item.amountMinor), 0);
    const accommodationMinor = nightlyRate * nights;
    return {
      property_id: data.propertyId, guest_name: data.guestName, guest_phone: data.guestPhone,
      guest_email: data.guestEmail, check_in_date: data.checkInDate, check_out_date: data.checkOutDate,
      adults: data.adults, children: data.children, status: data.status, nightly_rate_minor: nightlyRate,
      accommodation_minor: accommodationMinor, services_minor: servicesMinor,
      total_minor: accommodationMinor + servicesMinor, prepaid_minor: data.prepaidMinor,
      deposit_minor: data.depositMinor, deposit_status: data.depositStatus, notes: data.notes,
      actual_check_out_date: previous?.actual_check_out_date || null,
      meals: meals.map((item) => ({
        reservation_id: previous?.id || null,
        meal_date: item.date,
        meal_type: item.type,
        amount_minor: item.amountMinor,
      })),
    };
  };
  return {
    // There is no server behind the web build, and no way to deliver a one-time code, so the demo
    // starts signed in. It answers the same SHAPE as the real bridge, which is what the renderer
    // needs; it is not a fake login screen.
    auth: {
      status: () => response({
        authenticated: true,
        baseUrl: "demo",
        session: {
          token: "demo",
          accountId: "demo",
          accountName: "Демонстрационный аккаунт",
          user: { email: "demo@rentkeeper.test", name: "Демо-режим" },
          plan: "free",
        },
      }),
      send: () => response({ loginable: true, code: "000000" }),
      setup: () => response({ ok: true }),
      verify: () => response({ token: "demo", accountId: "demo", accountName: "Демонстрационный аккаунт", user: { email: "demo@rentkeeper.test", name: "Демо-режим" }, plan: "free" }),
      setPlan: () => response({ plan: "free" }),
      logout: () => response({ ok: true }),
    },
    dashboard: { get: () => response({ today: new Date().toISOString().slice(0, 10), activeProperties: properties.filter((p) => p.status === "active").length, activeReservations: reservations.filter((r) => ["hold", "confirmed", "checked_in"].includes(r.status)).length, expectedMinor: reservations.reduce((sum, r) => sum + Math.max(r.total_minor - r.prepaid_minor, 0), 0), refundsDueMinor: reservations.reduce((sum, r) => sum + Math.max(r.prepaid_minor - r.total_minor, 0), 0), depositsHeldMinor: reservations.filter((r) => r.deposit_status === "received").reduce((sum, r) => sum + r.deposit_minor, 0), arrivals: [], departures: [] }) },
    calendar: { get: (days = 14, startDate = null) => {
      // `startDate` is what makes the calendar navigable here too. Without it the demo could page
      // nowhere: every window began today, exactly as the desktop did before the same fix.
      const start = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
      const dates = Array.from({ length: days }, (_, index) => new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10));
      const occupancy = [];
      reservations.filter((r) => !["cancelled", "no_show"].includes(r.status)).forEach((r) => {
        for (let cursor = new Date(`${r.check_in_date}T00:00:00`); cursor < new Date(`${r.actual_check_out_date || r.check_out_date}T00:00:00`); cursor = new Date(cursor.getTime() + 86_400_000)) {
          occupancy.push({ property_id: r.property_id, night_date: cursor.toISOString().slice(0, 10), reservation_id: r.id, guest_name: r.guest_name, status: r.status });
        }
      });
      return response({ dates, startDate: dates[0], properties: properties.filter((p) => p.status === "active"), occupancy });
    } },
    places: {
      list: () => response(places),
      create: (data) => { if (places.some((p) => p.name.toLowerCase() === data.name.toLowerCase())) return error("Дом отдыха с таким названием уже существует"); const item = { id: String(Date.now()), name: data.name, address: data.address, has_food_service: data.hasFoodService ? 1 : 0, notes: data.notes, status: "active", active_unit_count: 0, total_unit_count: 0 }; places.push(item); return persistedResponse(item); },
      update: (id, data) => { const item = findById(places, id); Object.assign(item, { name: data.name, address: data.address, has_food_service: data.hasFoodService ? 1 : 0, notes: data.notes }); properties.filter((property) => idOf(property.place_id) === idOf(id)).forEach((property) => Object.assign(property, { place_name: item.name, place_address: item.address })); return persistedResponse(item); },
      archive: (id) => { findById(places, id).status = "archived"; return persistedResponse(true); },
      restore: (id) => { findById(places, id).status = "active"; return persistedResponse(true); },
    },
    properties: {
      list: () => response(properties),
      create: (data) => { if (properties.some((p) => p.name.toLowerCase() === data.name.toLowerCase())) return error("Дом с таким наименованием уже существует"); const place = findById(places, data.placeId); const item = { id: String(Date.now()), place_id: data.placeId || null, place_name: place?.name || null, place_address: place?.address || null, kind: data.kind, name: data.name, location: data.location, capacity: data.capacity, base_price_minor: data.basePriceMinor, deposit_minor: data.depositMinor, currency: data.currency, check_in_time: data.checkInTime, check_out_time: data.checkOutTime, notes: data.notes, status: "active", reservation_count: 0 }; properties.push(item); return persistedResponse(item); },
      update: (id, data) => { const item = findById(properties, id); const place = findById(places, data.placeId); Object.assign(item, { place_id: data.placeId || null, place_name: place?.name || null, place_address: place?.address || null, kind: data.kind, name: data.name, location: data.location, capacity: data.capacity, base_price_minor: data.basePriceMinor, deposit_minor: data.depositMinor, currency: data.currency, check_in_time: data.checkInTime, check_out_time: data.checkOutTime, notes: data.notes }); return persistedResponse(item); },
      archive: (id) => { findById(properties, id).status = "archived"; return persistedResponse(true); },
      restore: (id) => { findById(properties, id).status = "active"; return persistedResponse(true); },
    },
    reservations: {
      list: () => response(list()),
      create: (data) => { const item = { id: String(Date.now()), ...demoReservation(data) }; reservations.push(item); return persistedResponse(item); },
      update: (id, data) => { const item = findById(reservations, id); Object.assign(item, demoReservation(data, item)); return persistedResponse(item); },
      cancel: (id) => { findById(reservations, id).status = "cancelled"; return persistedResponse(true); },
      delete: (id) => { reservations = reservations.filter((r) => !(idOf(r.id) === idOf(id))); return persistedResponse(true); },
      earlyCheckout: (id, data) => {
        const item = findById(reservations, id);
        item.actual_check_out_date = data.actualCheckOutDate;
        item.status = "checked_out";
        item.meals = (item.meals || []).filter((meal) => meal.meal_date < data.actualCheckOutDate);
        item.services_minor = item.meals.reduce((sum, meal) => sum + Number(meal.amount_minor), 0);
        if (data.billingPolicy !== "keep_total") {
          item.accommodation_minor = item.nightly_rate_minor * nightsBetween(item.check_in_date, data.actualCheckOutDate);
        }
        item.total_minor = item.accommodation_minor + item.services_minor;
        return persistedResponse(item);
      },
    },
    backups: { list: () => response(backups), create: exportBackup },
    system: {
      info: () => {
        const today = new Date().toISOString().slice(0, 10);
        return response({
          databasePath: "Browser local storage",
          backupDir: "Browser downloads",
          databaseSize: new Blob([localStorage.getItem(storageKey) || ""]).size,
          bookingPolicy: {
            today,
            maximumCheckInDate: addDaysIso(today, 21),
            maximumCheckOutDate: null,
            maximumAdvanceDays: 21,
            maximumStayMonths: 3,
            timeZone: "Asia/Baku",
          },
          language: interfaceLanguage,
        });
      },
      setLanguage: (language) => {
        interfaceLanguage = ["ru", "az", "en"].includes(language) ? language : "ru";
        return persistedResponse(interfaceLanguage);
      },
      openBackupDirectory: () => response(true),
      setDocumentRequisites: (data) => {
        requisites = { ...requisites, ...data };
        return persistedResponse(requisites);
      },
    },
    // The browser build has no Electron main process to render a PDF in, so a document is
    // downloaded as an HTML file instead of silently doing nothing. The demo is a preview of the
    // product, and a button that appears to work is more honest than one that is missing.
    documents: {
      html: (data) => response(documentPreviewHtml(data)),
      create: () => error("PDF создаётся только в приложении для компьютера"),
      folder: () => response("Browser downloads"),
      openFolder: () => response("Browser downloads"),
    },
  };
}
