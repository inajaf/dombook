const fs = require("node:fs");
const { dashboard } = require("../src/domain/reports.cjs");
const os = require("node:os");
const path = require("node:path");
const { RentKeeperDatabase } = require("../src/database.cjs");
const { todayInTimeZone, addDaysIso } = require("../src/domain/booking/booking-policy.cjs");

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentkeeper-smoke-"));
  const database = await new RentKeeperDatabase({
    filePath: path.join(tempDir, "smoke.sqlite"),
    backupDir: path.join(tempDir, "backups"),
    seed: false,
  }).init();

  try {
    const checkInDate = addDaysIso(todayInTimeZone(), 1);
    const property = database.createProperty({
      name: "Smoke House",
      location: "Local",
      capacity: 4,
      basePriceMinor: 20000,
      depositMinor: 30000,
      currency: "AZN",
      checkInTime: "15:00",
      checkOutTime: "11:00",
      notes: "",
    });
    const booking = database.createReservation({
      propertyId: property.id,
      guestName: "Smoke Guest",
      guestPhone: "",
      guestEmail: "",
      checkInDate,
      checkOutDate: addDaysIso(checkInDate, 2),
      adults: 2,
      children: 0,
      status: "confirmed",
      totalMinor: 40000,
      prepaidMinor: 10000,
      depositMinor: 30000,
      depositStatus: "received",
      notes: "",
    });
    const summary = dashboard(database);
    const backup = database.createBackup();
    console.log(JSON.stringify({
      ok: true,
      propertyId: property.id,
      reservationId: booking.id,
      activeReservations: summary.activeReservations,
      backup: path.basename(backup.path),
    }, null, 2));
  } finally {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

