// Flexible pricing: seasons, length discounts, and what the guest is actually charged.
const { listProperties } = require("../src/domain/reports.cjs");
//
// The arithmetic itself is pinned by fixtures/pricing-cases.json in both languages
// (tests/pricing.test.cjs and server/internal/domain/pricing_test.go). This file covers the part
// those cannot: that a unit's stored rules reach the booking, that a rule set which could never
// be priced is refused when it is saved, and that the amount frozen on a booking keeps the
// working that produced it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RentKeeperDatabase } = require("../src/database.cjs");

async function createTestDatabase(t, today = "2026-07-29") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentkeeper-pricing-"));
  const database = await new RentKeeperDatabase({
    filePath: path.join(tempDir, "test.sqlite"),
    backupDir: path.join(tempDir, "backups"),
    seed: false,
    todayProvider: () => today,
  }).init();
  t.after(() => {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { database, tempDir };
}

function unit(overrides = {}) {
  return {
    name: "Дом у моря",
    location: "Баку",
    capacity: 4,
    basePriceMinor: 20000,
    monthlyRateMinor: 400000,
    depositMinor: 30000,
    currency: "AZN",
    checkInTime: "15:00",
    checkOutTime: "11:00",
    notes: "",
    ...overrides,
  };
}

function booking(propertyId, overrides = {}) {
  return {
    propertyId,
    guestName: "Тестовый гость",
    guestPhone: "+994501112233",
    guestEmail: "guest@example.com",
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-13",
    adults: 2,
    children: 0,
    status: "confirmed",
    prepaidMinor: 0,
    depositMinor: 0,
    depositStatus: "none",
    notes: "",
    ...overrides,
  };
}

const NEW_YEAR = {
  seasons: [{ name: "Новый год", from: "2026-12-25", to: "2027-01-10", nightlyRateMinor: 40000 }],
};

test("сезон меняет цену только тех ночей, которые в него попадают", async (t) => {
  // `today` is pinned inside the booking window: the advance rule is a separate concern and a
  // test that trips it reports a booking-window error where it meant to assert a price.
  const { database } = await createTestDatabase(t, "2026-12-14");
  const property = database.createProperty(unit({ rateRules: NEW_YEAR }));

  // Three nights outside the season, then two inside it.
  const created = database.createReservation(booking(property.id, {
    checkInDate: "2026-12-23",
    checkOutDate: "2026-12-28",
  }));

  assert.equal(created.accommodation_minor, 2 * 20000 + 3 * 40000);
  const breakdown = JSON.parse(created.rate_breakdown);
  assert.deepEqual(breakdown.lines.map((line) => [line.label, line.nightlyRateMinor, line.nights]), [
    ["", 20000, 2],
    ["Новый год", 40000, 3],
  ]);
});

test("скидка за длительность применяется от порога и хранится вместе с бронью", async (t) => {
  const { database } = await createTestDatabase(t, "2027-02-20");
  const property = database.createProperty(unit({
    rateRules: { stayDiscounts: [{ minimumNights: 7, percent: 10 }] },
  }));

  const week = database.createReservation(booking(property.id, {
    checkInDate: "2027-03-01",
    checkOutDate: "2027-03-08",
  }));
  assert.equal(week.accommodation_minor, 140000 - 14000);
  const breakdown = JSON.parse(week.rate_breakdown);
  assert.equal(breakdown.grossMinor, 140000);
  assert.equal(breakdown.discountPercent, 10);
  assert.equal(breakdown.totalMinor, 126000);

  // One night short of the threshold pays full price, so the discount is a threshold and not a
  // rounding of the rate.
  const short = database.createReservation(booking(property.id, {
    guestName: "Короткий гость",
    checkInDate: "2027-03-09",
    checkOutDate: "2027-03-15",
  }));
  assert.equal(short.accommodation_minor, 120000);
});

test("правила цен, которые нельзя посчитать однозначно, не сохраняются", async (t) => {
  const { database } = await createTestDatabase(t);
  assert.throws(
    () => database.createProperty(unit({
      rateRules: {
        seasons: [
          { from: "2026-12-25", to: "2027-01-10", nightlyRateMinor: 40000 },
          { from: "2027-01-05", to: "2027-01-20", nightlyRateMinor: 45000 },
        ],
      },
    })),
    /Сезоны пересекаются/,
  );
  // The refusal must not leave a half-written unit behind.
  assert.equal(listProperties(database).filter((item) => item.name === "Дом у моря").length, 0);
});

test("подразделение без правил считается по базовой цене, как и раньше", async (t) => {
  // Every unit that already exists has no rules. Their bookings must not move on upgrade.
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(unit());
  assert.equal(property.rate_rules, "{}");
  const created = database.createReservation(booking(property.id));
  assert.equal(created.accommodation_minor, 60000);
});

test("правила цен переживают запись и чтение через базу", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(unit({ rateRules: NEW_YEAR }));
  const stored = database.getProperty(property.id);
  assert.equal(JSON.parse(stored.rate_rules).seasons[0].nightlyRateMinor, 40000);

  const updated = database.updateProperty(property.id, unit({ rateRules: { stayDiscounts: [{ minimumNights: 7, percent: 5 }] } }));
  assert.equal(JSON.parse(updated.rate_rules).seasons.length, 0);
  assert.equal(JSON.parse(updated.rate_rules).stayDiscounts[0].percent, 5);
});

test("аренда на год дешевле в месяц, чем аренда на три месяца", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(unit({
    rateRules: { tenancyDiscounts: [{ minimumMonths: 12, percent: 10 }] },
  }));

  const quarter = database.createReservation(booking(property.id, {
    bookingKind: "rental",
    checkInDate: "2026-08-01",
    checkOutDate: "2026-11-01",
  }));
  const year = database.createReservation(booking(property.id, {
    bookingKind: "rental",
    guestName: "Долгий жилец",
    checkInDate: "2027-02-01",
    checkOutDate: "2028-02-01",
  }));

  assert.equal(quarter.accommodation_minor, 3 * 400000);
  assert.equal(year.accommodation_minor, 12 * 400000 - 480000);
  const breakdown = JSON.parse(year.rate_breakdown);
  assert.equal(breakdown.months, 12);
  assert.equal(breakdown.effectiveMonthlyMinor, 360000);
  assert.ok(breakdown.effectiveMonthlyMinor < 400000, "a year must be cheaper per month");
});

test("досрочный выезд пересчитывает проживание по сезонам, а не по ночам", async (t) => {
  const { database } = await createTestDatabase(t, "2026-12-20");
  const property = database.createProperty(unit({ rateRules: NEW_YEAR }));
  const created = database.createReservation(booking(property.id, {
    checkInDate: "2026-12-28",
    checkOutDate: "2027-01-02",
  }));
  // Five nights, all inside the season.
  assert.equal(created.accommodation_minor, 5 * 40000);

  const checkedOut = database.earlyCheckout(created.id, {
    actualCheckOutDate: "2026-12-30",
    billingPolicy: "recalculate",
  });
  // Two nights kept, both still in the season — charging the base rate here would silently
  // refund the peak-week surcharge for nights the guest actually stayed.
  assert.equal(checkedOut.accommodation_minor, 2 * 40000);
  assert.equal(JSON.parse(checkedOut.rate_breakdown).lines[0].nightlyRateMinor, 40000);
});

test("досрочное расторжение аренды считается целыми месяцами, а не ночами", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(unit());
  const created = database.createReservation(booking(property.id, {
    bookingKind: "rental",
    checkInDate: "2026-08-01",
    checkOutDate: "2027-08-01",
  }));
  assert.equal(created.accommodation_minor, 12 * 400000);

  const ended = database.earlyCheckout(created.id, {
    actualCheckOutDate: "2026-12-02",
    billingPolicy: "recalculate",
  });
  // Four whole months elapsed. Multiplying the monthly rate by the 123 nights stayed would have
  // produced 2 460 000 — a number that looks like rent and is not one. The part-month is not
  // charged, the same way a tenancy is never priced for the fraction of a month it nearly ran.
  assert.equal(ended.accommodation_minor, 4 * 400000);
  assert.equal(JSON.parse(ended.rate_breakdown).months, 4);
});

test("досрочное расторжение в первый месяц стоит один месяц", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(unit());
  const created = database.createReservation(booking(property.id, {
    bookingKind: "rental",
    checkInDate: "2026-08-01",
    checkOutDate: "2027-08-01",
  }));
  const ended = database.earlyCheckout(created.id, {
    actualCheckOutDate: "2026-08-20",
    billingPolicy: "recalculate",
  });
  // Zero whole months would make a tenancy that has begun free.
  assert.equal(ended.accommodation_minor, 400000);
});

test("договорная сумма не подменяется расчётом", async (t) => {
  const { database } = await createTestDatabase(t, "2026-12-20");
  const property = database.createProperty(unit({ rateRules: NEW_YEAR }));
  const created = database.createReservation(booking(property.id, {
    checkInDate: "2026-12-28",
    checkOutDate: "2027-01-02",
    accommodationMinor: 150000,
  }));
  assert.equal(created.accommodation_minor, 150000);
  // No breakdown is invented for an agreed figure: an arithmetic explanation next to a number
  // that was negotiated is a lie about how it was reached.
  assert.deepEqual(JSON.parse(created.rate_breakdown), {});
});

test("сломанные правила в базе не мешают оформить бронь", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(unit());
  // A row written by a client that stored something else. Refusing the booking would turn a
  // malformed settings value into a unit nobody can sell.
  database.run("UPDATE properties SET rate_rules = ? WHERE id = ?", ["{ not json", property.id]);
  const created = database.createReservation(booking(property.id));
  assert.equal(created.accommodation_minor, 60000);
});
