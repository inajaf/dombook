const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DomBookDatabase, eachNight } = require("../src/database.cjs");

async function createTestDatabase(t, today = "2026-07-29") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-test-"));
  const database = await new DomBookDatabase({
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

function house(overrides = {}) {
  return {
    name: "Тестовый дом",
    location: "Баку",
    capacity: 4,
    basePriceMinor: 20000,
    depositMinor: 30000,
    currency: "AZN",
    checkInTime: "15:00",
    checkOutTime: "11:00",
    notes: "",
    ...overrides,
  };
}

function reservation(propertyId, overrides = {}) {
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
    totalMinor: 60000,
    prepaidMinor: 20000,
    depositMinor: 30000,
    depositStatus: "due",
    notes: "",
    ...overrides,
  };
}

test("eachNight использует полуоткрытый диапазон [заезд, выезд)", () => {
  assert.deepEqual(eachNight("2026-08-10", "2026-08-13"), [
    "2026-08-10",
    "2026-08-11",
    "2026-08-12",
  ]);
});

test("календарные даты проверяются строго без автоматической нормализации", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house());

  for (const invalidDate of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "29.02.2026"]) {
    assert.throws(
      () => database.createReservation(reservation(property.id, { checkInDate: invalidDate })),
      /неверная дата/,
    );
  }

  const { database: leapDatabase } = await createTestDatabase(t, "2028-02-28");
  const leapProperty = leapDatabase.createProperty(house({ name: "Дом високосного года" }));
  const leapReservation = leapDatabase.createReservation(reservation(leapProperty.id, {
    checkInDate: "2028-02-29",
    checkOutDate: "2028-03-01",
  }));
  assert.equal(leapReservation.check_in_date, "2028-02-29");
});

test("CRUD домов создаёт, обновляет, архивирует и восстанавливает объект", async (t) => {
  const { database } = await createTestDatabase(t);
  const created = database.createProperty(house());
  assert.equal(created.name, "Тестовый дом");
  assert.equal(created.status, "active");

  const updated = database.updateProperty(created.id, house({ name: "Дом у моря", capacity: 6 }));
  assert.equal(updated.name, "Дом у моря");
  assert.equal(updated.capacity, 6);

  assert.equal(database.archiveProperty(created.id).status, "archived");
  assert.equal(database.restoreProperty(created.id).status, "active");
});

test("дом отдыха группирует несколько независимо сдаваемых коттеджей", async (t) => {
  const { database } = await createTestDatabase(t);
  const place = database.createPlace({
    name: "Лесная долина",
    address: "Габала",
    notes: "",
  });
  database.createProperty(house({ name: "Коттедж 1", kind: "cottage", placeId: place.id }));
  database.createProperty(house({ name: "Коттедж 2", kind: "cottage", placeId: place.id }));

  const units = database.listProperties().filter((item) => item.place_id === place.id);
  assert.equal(units.length, 2);
  assert.equal(units[0].place_name, "Лесная долина");
  assert.equal(database.listPlaces()[0].active_unit_count, 2);
});

test("каждый дом отдыха сохраняет только свои объекты после перезапуска базы", async (t) => {
  const { database, tempDir } = await createTestDatabase(t);
  const firstPlace = database.createPlace({ name: "Комплекс Альфа", address: "Габала", notes: "" });
  const secondPlace = database.createPlace({ name: "Комплекс Бета", address: "Шеки", notes: "" });
  database.createProperty(house({ name: "Альфа 1", kind: "cottage", placeId: firstPlace.id }));
  database.createProperty(house({ name: "Альфа 2", kind: "cottage", placeId: firstPlace.id }));
  database.createProperty(house({ name: "Бета 1", kind: "cottage", placeId: secondPlace.id }));
  database.createProperty(house({ name: "Отдельный дом", kind: "house", placeId: null }));
  database.close();

  const reopened = await new DomBookDatabase({
    filePath: path.join(tempDir, "test.sqlite"),
    backupDir: path.join(tempDir, "backups"),
    seed: false,
  }).init();
  try {
    const properties = reopened.listProperties();
    assert.deepEqual(
      properties.filter((item) => item.place_id === firstPlace.id).map((item) => item.name).sort(),
      ["Альфа 1", "Альфа 2"],
    );
    assert.deepEqual(
      properties.filter((item) => item.place_id === secondPlace.id).map((item) => item.name),
      ["Бета 1"],
    );
    assert.deepEqual(
      properties.filter((item) => item.place_id === null).map((item) => item.name),
      ["Отдельный дом"],
    );
  } finally {
    reopened.close();
  }
});

test("язык интерфейса сохраняется в SQLite и восстанавливается после перезапуска", async (t) => {
  const { database, tempDir } = await createTestDatabase(t);
  assert.equal(database.systemInfo().language, "ru");
  assert.equal(database.setLanguage("az"), "az");
  assert.equal(database.systemInfo().language, "az");
  assert.throws(() => database.setLanguage("de"), /ru, az, en/);
  database.close();

  const reopened = await new DomBookDatabase({
    filePath: path.join(tempDir, "test.sqlite"),
    backupDir: path.join(tempDir, "backups"),
    seed: false,
    todayProvider: () => "2026-07-29",
  }).init();
  try {
    assert.equal(reopened.systemInfo().language, "az");
    assert.equal(reopened.setLanguage("en"), "en");
  } finally {
    reopened.close();
  }
});

test("наименование дома уникально без учёта регистра", async (t) => {
  const { database } = await createTestDatabase(t);
  database.createProperty(house({ name: "Сосны" }));
  assert.throws(() => database.createProperty(house({ name: "сосны" })), /уже существует/);
});

test("двойная бронь одного дома на одну ночь отклоняется", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house());
  database.createReservation(reservation(property.id));

  assert.throws(
    () => database.createReservation(reservation(property.id, {
      guestName: "Другой гость",
      checkInDate: "2026-08-12",
      checkOutDate: "2026-08-14",
    })),
    /уже занят 2026-08-12/,
  );
  assert.equal(database.listReservations().length, 1);
});

test("отмена освобождает ночи для новой брони", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house());
  const first = database.createReservation(reservation(property.id));
  database.cancelReservation(first.id);

  const second = database.createReservation(reservation(property.id, { guestName: "Новый гость" }));
  assert.ok(second.id > first.id);
  assert.equal(database.listReservations().filter((item) => item.status === "cancelled").length, 1);
});

test("удаление брони доступно после отмены и сохраняет запись аудита", async (t) => {
  const { database, tempDir } = await createTestDatabase(t);
  const property = database.createProperty(house());
  const created = database.createReservation(reservation(property.id));

  assert.throws(
    () => database.deleteReservation(created.id),
    /Сначала отмените активную бронь/,
  );

  database.cancelReservation(created.id);
  assert.equal(database.deleteReservation(created.id), true);
  assert.equal(database.getReservation(created.id), null);
  assert.equal(database.query("SELECT COUNT(*) AS count FROM reservation_nights WHERE reservation_id = ?", [created.id])[0].count, 0);
  assert.equal(database.query("SELECT COUNT(*) AS count FROM reservation_meals WHERE reservation_id = ?", [created.id])[0].count, 0);

  const audit = database.query(
    "SELECT payload_json FROM audit_log WHERE entity_type = 'reservation' AND entity_id = ? AND action = 'deleted'",
    [created.id],
  )[0];
  assert.equal(JSON.parse(audit.payload_json).guestName, "Тестовый гость");

  const replacement = database.createReservation(reservation(property.id));
  assert.ok(replacement.id > created.id);
  database.close();

  const reopened = await new DomBookDatabase({
    filePath: path.join(tempDir, "test.sqlite"),
    backupDir: path.join(tempDir, "backups"),
    seed: false,
  }).init();
  try {
    assert.equal(reopened.getReservation(created.id), null);
    assert.ok(reopened.getReservation(replacement.id));
  } finally {
    reopened.close();
  }
});

test("ошибка сохранения после commit не маскируется ошибкой rollback", async (t) => {
  const { database } = await createTestDatabase(t);
  const originalPersist = database.persist.bind(database);
  database.persist = () => {
    throw new Error("disk unavailable");
  };

  assert.throws(() => database.createProperty(house()), /disk unavailable/);
  assert.equal(database.listProperties().length, 1);
  database.persist = originalPersist;
});

test("вместимость дома проверяется до сохранения", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house({ capacity: 2 }));
  assert.throws(
    () => database.createReservation(reservation(property.id, { adults: 2, children: 1 })),
    /Вместимость дома — 2/,
  );
});

test("предоплата и статус депозита проходят финансовые проверки", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house());

  assert.throws(
    () => database.createReservation(reservation(property.id, {
      prepaidMinor: 70000,
    })),
    /Предоплата не может быть больше/,
  );
  assert.throws(
    () => database.createReservation(reservation(property.id, {
      depositMinor: 0,
      depositStatus: "received",
    })),
    /укажите сумму/,
  );
});

test("предоплата 50 AZN уменьшает долг за ночь 200 AZN до 150 AZN", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house({ basePriceMinor: 20000 }));
  database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-11",
    prepaidMinor: 5000,
  }));

  const saved = database.listReservations()[0];
  assert.equal(saved.nightly_rate_minor, 20000);
  assert.equal(saved.accommodation_minor, 20000);
  assert.equal(saved.services_minor, 0);
  assert.equal(saved.total_minor, 20000);
  assert.equal(saved.balance_minor, 15000);
  assert.equal(saved.deposit_minor, 30000);
});

test("SQLite-слой разрешает заезд через 21 день и запрещает через 22 дня", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house());
  assert.doesNotThrow(() => database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-19",
    checkOutDate: "2026-08-20",
  })));
  assert.throws(() => database.createReservation(reservation(property.id, {
    guestName: "Слишком ранняя будущая бронь",
    checkInDate: "2026-08-20",
    checkOutDate: "2026-08-21",
  })), /максимум на 21 день/);
});

test("SQLite-слой ограничивает проживание тремя календарными месяцами", async (t) => {
  const { database } = await createTestDatabase(t);
  const allowedProperty = database.createProperty(house({ name: "Допустимый срок" }));
  const rejectedProperty = database.createProperty(house({ name: "Слишком длинный срок" }));
  assert.doesNotThrow(() => database.createReservation(reservation(allowedProperty.id, {
    checkInDate: "2026-08-01",
    checkOutDate: "2026-11-01",
  })));
  assert.throws(() => database.createReservation(reservation(rejectedProperty.id, {
    checkInDate: "2026-08-01",
    checkOutDate: "2026-11-02",
  })), /дольше 3 календарных месяцев/);
});

test("финансовое редактирование старой длинной брони разрешено без расширения дат", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house());
  const created = database.createReservation(reservation(property.id));
  database.run(
    "UPDATE reservations SET check_in_date = ?, check_out_date = ? WHERE id = ?",
    ["2026-01-01", "2026-05-01", created.id],
  );
  assert.doesNotThrow(() => database.updateReservation(created.id, reservation(property.id, {
    checkInDate: "2026-01-01",
    checkOutDate: "2026-05-01",
    prepaidMinor: 25000,
  })));
  assert.throws(() => database.updateReservation(created.id, reservation(property.id, {
    checkInDate: "2026-01-01",
    checkOutDate: "2026-05-02",
    prepaidMinor: 25000,
  })), /дольше 3 календарных месяцев/);
});

test("завтрак, обед и ужин вводятся отдельной суммой на каждый день и суммируются", async (t) => {
  const { database } = await createTestDatabase(t);
  const place = database.createPlace({
    name: "Дом отдыха с рестораном",
    address: "Габала",
    hasFoodService: true,
    notes: "",
  });
  const property = database.createProperty(house({ placeId: place.id, basePriceMinor: 20000 }));
  database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-13",
    prepaidMinor: 5000,
    mealItems: [
      { date: "2026-08-10", type: "breakfast", amountMinor: 1000 },
      { date: "2026-08-10", type: "lunch", amountMinor: 2000 },
      { date: "2026-08-10", type: "dinner", amountMinor: 3000 },
      { date: "2026-08-11", type: "lunch", amountMinor: 1500 },
      { date: "2026-08-12", type: "dinner", amountMinor: 2500 },
    ],
  }));

  const saved = database.listReservations()[0];
  assert.equal(saved.accommodation_minor, 60000);
  assert.equal(saved.services_minor, 10000);
  assert.equal(saved.total_minor, 70000);
  assert.equal(saved.balance_minor, 65000);
  assert.equal(saved.deposit_minor, 30000);
  assert.equal(saved.meals.length, 5);
});

test("питание нельзя добавить дому без кухни или ресторана", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house());
  assert.throws(() => database.createReservation(reservation(property.id, {
    mealItems: [{ date: "2026-08-10", type: "lunch", amountMinor: 2000 }],
  })), /питание недоступно/);
});

test("питание вне проживания и повтор одного приёма пищи отклоняются", async (t) => {
  const { database } = await createTestDatabase(t);
  const place = database.createPlace({
    name: "Комплекс с кухней",
    address: "",
    hasFoodService: true,
    notes: "",
  });
  const property = database.createProperty(house({ placeId: place.id }));
  assert.throws(() => database.createReservation(reservation(property.id, {
    mealItems: [{ date: "2026-08-13", type: "breakfast", amountMinor: 1000 }],
  })), /вне фактических дат проживания/);
  assert.throws(() => database.createReservation(reservation(property.id, {
    mealItems: [
      { date: "2026-08-10", type: "dinner", amountMinor: 1000 },
      { date: "2026-08-10", type: "dinner", amountMinor: 2000 },
    ],
  })), /указано повторно/);
});

test("зафиксированная цена ночи не меняется, а суммы питания по дням сохраняются", async (t) => {
  const { database } = await createTestDatabase(t);
  const place = database.createPlace({
    name: "Комплекс",
    address: "",
    hasFoodService: true,
    notes: "",
  });
  const property = database.createProperty(house({ placeId: place.id, basePriceMinor: 20000 }));
  const created = database.createReservation(reservation(property.id, {
    mealItems: [{ date: "2026-08-10", type: "lunch", amountMinor: 4000 }],
  }));
  database.updateProperty(property.id, house({ placeId: place.id, basePriceMinor: 25000 }));
  database.updatePlace(place.id, {
    name: "Комплекс",
    address: "",
    hasFoodService: true,
    notes: "",
  });
  database.updateReservation(created.id, reservation(property.id, {
    mealItems: [{ date: "2026-08-10", type: "lunch", amountMinor: 4000 }],
  }));

  const saved = database.listReservations()[0];
  assert.equal(saved.nightly_rate_minor, 20000);
  assert.equal(saved.total_minor, 64000);
});

test("досрочный выезд убирает питание за освобождённые даты и оставляет прошедшее", async (t) => {
  const { database } = await createTestDatabase(t);
  const place = database.createPlace({
    name: "Дом отдыха с питанием",
    address: "",
    hasFoodService: true,
    notes: "",
  });
  const property = database.createProperty(house({ placeId: place.id, basePriceMinor: 20000 }));
  const created = database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-13",
    prepaidMinor: 0,
    mealItems: [
      { date: "2026-08-10", type: "lunch", amountMinor: 7000 },
      { date: "2026-08-11", type: "dinner", amountMinor: 5000 },
      { date: "2026-08-12", type: "breakfast", amountMinor: 3000 },
    ],
  }));

  const checkedOut = database.earlyCheckout(created.id, {
    actualCheckOutDate: "2026-08-11",
    billingPolicy: "recalculate",
  });

  assert.equal(checkedOut.accommodation_minor, 20000);
  assert.equal(checkedOut.services_minor, 7000);
  assert.equal(checkedOut.total_minor, 27000);
  assert.deepEqual(checkedOut.meals.map((meal) => meal.meal_date), ["2026-08-10"]);
});

test("досрочный выезд освобождает будущие ночи и пересчитывает долг", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house({ basePriceMinor: 20000 }));
  const created = database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-14",
    prepaidMinor: 5000,
  }));
  const checkedOut = database.earlyCheckout(created.id, {
    actualCheckOutDate: "2026-08-12",
    billingPolicy: "recalculate",
  });

  assert.equal(checkedOut.status, "checked_out");
  assert.equal(checkedOut.actual_check_out_date, "2026-08-12");
  assert.equal(checkedOut.accommodation_minor, 40000);
  assert.equal(checkedOut.balance_minor, 35000);
  assert.deepEqual(
    database.query("SELECT night_date FROM reservation_nights WHERE reservation_id = ? ORDER BY night_date", [created.id])
      .map((item) => item.night_date),
    ["2026-08-10", "2026-08-11"],
  );
  assert.doesNotThrow(() => database.createReservation(reservation(property.id, {
    guestName: "Следующий гость",
    checkInDate: "2026-08-12",
    checkOutDate: "2026-08-14",
  })));
});

test("досрочный выезд показывает возврат, если предоплата больше нового счёта", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house({ basePriceMinor: 20000 }));
  const created = database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-13",
    prepaidMinor: 50000,
  }));
  const checkedOut = database.earlyCheckout(created.id, {
    actualCheckOutDate: "2026-08-11",
    billingPolicy: "recalculate",
  });
  assert.equal(checkedOut.balance_minor, 0);
  assert.equal(checkedOut.refund_due_minor, 30000);
  assert.equal(database.dashboard().refundsDueMinor, 30000);
});

test("при политике полной оплаты досрочный выезд освобождает календарь без снижения суммы", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house({ basePriceMinor: 20000 }));
  const created = database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-13",
  }));
  const checkedOut = database.earlyCheckout(created.id, {
    actualCheckOutDate: "2026-08-11",
    billingPolicy: "keep_total",
  });
  assert.equal(checkedOut.accommodation_minor, 60000);
  assert.equal(checkedOut.total_minor, 60000);
  assert.equal(database.query("SELECT COUNT(*) AS count FROM reservation_nights WHERE reservation_id = ?", [created.id])[0].count, 1);
});

test("редактирование оплаты после досрочного выезда не занимает освобождённые ночи снова", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house({ basePriceMinor: 20000 }));
  const created = database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-13",
  }));
  database.earlyCheckout(created.id, {
    actualCheckOutDate: "2026-08-11",
    billingPolicy: "recalculate",
  });
  database.updateReservation(created.id, reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-13",
    status: "checked_out",
    prepaidMinor: 20000,
  }));

  assert.deepEqual(
    database.query("SELECT night_date FROM reservation_nights WHERE reservation_id = ?", [created.id])
      .map((item) => item.night_date),
    ["2026-08-10"],
  );
  assert.equal(database.listReservations()[0].actual_check_out_date, "2026-08-11");
});

test("стоимость, предоплата, остаток и депозит считаются независимо", async (t) => {
  const { database } = await createTestDatabase(t);
  const property = database.createProperty(house({ basePriceMinor: 18500, depositMinor: 25000 }));
  database.createReservation(reservation(property.id, {
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-13",
    totalMinor: 55500,
    prepaidMinor: 20000,
    depositMinor: 25000,
    depositStatus: "received",
  }));

  const saved = database.listReservations()[0];
  const dashboard = database.dashboard();
  assert.equal(saved.total_minor, 55500);
  assert.equal(saved.prepaid_minor, 20000);
  assert.equal(saved.balance_minor, 35500);
  assert.equal(saved.deposit_minor, 25000);
  assert.equal(dashboard.expectedMinor, 35500);
  assert.equal(dashboard.depositsHeldMinor, 25000);
});

test("backup создаёт валидный файл и checksum", async (t) => {
  const { database } = await createTestDatabase(t);
  database.createProperty(house());
  const backup = database.createBackup();
  assert.ok(fs.existsSync(backup.path));
  assert.match(backup.checksum, /^[a-f0-9]{64}$/);
  assert.equal(database.listBackups().length, 1);
});
