const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DomBookDatabase } = require("../src/database.cjs");

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-smoke-"));
  const database = await new DomBookDatabase({
    filePath: path.join(tempDir, "smoke.sqlite"),
    backupDir: path.join(tempDir, "backups"),
    seed: false,
  }).init();

  try {
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
      checkInDate: "2026-08-10",
      checkOutDate: "2026-08-12",
      adults: 2,
      children: 0,
      status: "confirmed",
      totalMinor: 40000,
      prepaidMinor: 10000,
      depositMinor: 30000,
      depositStatus: "received",
      notes: "",
    });
    const dashboard = database.dashboard();
    const backup = database.createBackup();
    console.log(JSON.stringify({
      ok: true,
      propertyId: property.id,
      reservationId: booking.id,
      activeReservations: dashboard.activeReservations,
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

