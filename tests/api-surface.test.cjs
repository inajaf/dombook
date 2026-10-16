const test = require("node:test");
const assert = require("node:assert/strict");
const { RentKeeperDatabase } = require("../src/database.cjs");

// A REFACTORING PIN, written before the class was split.
//
// The suite already pins what the domain DOES: it builds a real legacy database, migrates it and
// asserts the rows survive. It does not pin what the class OFFERS, and a move is exactly the
// operation that drops a method nobody happened to call in a test. A renamed or deleted method
// that no test touches passes every behavioural check and fails in the application, at the moment
// a user opens the screen that needed it.
//
// The list changed here, when the schema work moved to `src/domain/migrations.cjs`: `migrate`,
// `migrateLegacyIntegerIds`, `rebuildReservationsForConflictStatus`, `ensureColumn` and
// `ensureOutboxColumns` are gone from the class. The pin failed first, and the names were removed
// only after grepping every file outside `database.cjs` and the new module and finding no caller.
// Removing a name nobody calls is the refactor working. Removing one somebody calls is the failure
// this exists to prevent, and the two look identical in a diff.
//
// So the surface is written down. It was captured from the RUNTIME prototype, not from a scan of
// the source: the first draft of this list came from reading the file and was missing eight
// members, because an accessor and a differently declared method do not look like the pattern the
// scan was looking for. That is the same blindness the pin exists to catch, one level up. It is expected to change when the API changes on purpose, and
// the change belongs in this list in the same commit.
const EXPECTED = [
  "acknowledgeSync",
  "archivePlace",
  "archiveProperty",
  "audit",
  "bookingPolicy",
  "calendar",
  "cancelReservation",
  "close",
  "createBackup",
  "createPlace",
  "createProperty",
  "createReservation",
  "dashboard",
  "deleteReservation",
  "documentRequisites",
  "earlyCheckout",
  "enqueueSync",
  "ensureDeviceId",
  "entitlements",
  "failedSyncCount",
  "getLanguage",
  "getPlace",
  "getProperty",
  "getReservation",
  "hasNeverSynced",
  "init",
  "insertNights",
  "insertRow",
  "insertRowRaw",
  "listBackups",
  "listPlaces",
  "listProperties",
  "listReservations",
  "pendingSyncCount",
  "pendingSyncEntries",
  "persist",
  "pruneBackups",
  "query",
  "recordSyncFailure",
  "replaceReservationMeals",
  "reset",
  "restorePlace",
  "restoreProperty",
  "run",
  "scalar",
  "seedDemoData",
  "setBookingPolicy",
  "setDocumentRequisites",
  "setEntitlements",
  "setLanguage",
  "systemInfo",
  "transaction",
  "unitAllowance",
  "unitAllowanceStatus",
  "updatePlace",
  "updateProperty",
  "updateReservation",
  "upsertSetting",
  "validatePlace",
  "validateProperty",
  "validatePropertyRateRules",
  "validateReservation",
];

test("поверхность класса не меняется при перемещении кода", () => {
  const actual = Object.getOwnPropertyNames(RentKeeperDatabase.prototype)
    .filter((name) => name !== "constructor")
    .sort();
  const missing = EXPECTED.filter((name) => !actual.includes(name));
  const added = actual.filter((name) => !EXPECTED.includes(name));
  assert.deepEqual(missing, [], "метод пропал: приложение упадёт там, где его зовут");
  assert.deepEqual(added, [], "появился метод, которого нет в списке: допишите его сюда в том же коммите");
});
