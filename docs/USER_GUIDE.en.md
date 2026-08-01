# DomBook user guide

DomBook is a booking manager for owners of resorts, cottages and standalone rental houses. It is designed for one administrator and keeps the daily workflow simple: properties, calendar, guests, payments, deposits, meals and backups are available in one place.

## 1. Install or open DomBook

### macOS

1. Download the macOS `.dmg` or `.zip` from the GitHub Release.
2. Move **DomBook** to Applications and open it.
3. The public build is not Apple-notarized. If macOS blocks the first launch, right-click the app and choose **Open**, or allow it in **System Settings → Privacy & Security**.

### Windows

1. Download the Windows installer or portable `.exe` from the GitHub Release.
2. Run the installer, or open the portable edition without installation.
3. The public build is not code-signed. Windows SmartScreen may show a warning; use **More info → Run anyway** only when the file came from the official DomBook release.

### Web edition

1. Download and unzip `DomBook-…-web.zip`.
2. Serve the extracted `web` folder through any static server. For example:

   ```bash
   python3 -m http.server 8080 --directory web
   ```

3. Open `http://127.0.0.1:8080/`.

The Web edition stores data in the current browser's local storage. Clearing browser data removes it. Export JSON backups regularly. The desktop editions use a local SQLite database and are recommended for daily production work.

## 2. First setup

1. Open **Properties**.
2. For a resort with several cottages, choose **Add resort** and enter its name and address.
3. Enable food service when the resort has a kitchen or restaurant.
4. Open the resort and choose **Add cottage** for every separately bookable cottage.
5. For an independent rental house, choose **Add standalone house**.

Each cottage or house has its own capacity, nightly price, refundable deposit, check-in time and check-out time. Every unit receives an independent calendar.

## 3. Create a reservation

1. Click **New reservation**, or click a free `+` cell in the calendar.
2. Select the house and dates.
3. Enter the guest name, phone, number of adults and children.
4. Enter the prepaid booking amount and refundable security deposit separately.
5. Select the booking and deposit statuses.
6. If food service is enabled, enter the total breakfast, lunch or dinner amount for each day. Enter the complete amount for the group, not a price per portion.
7. Check the calculation and save.

The stay amount is calculated as `number of nights × locked nightly rate`. Prepayment reduces the outstanding balance. The refundable deposit is tracked separately and is not counted as accommodation revenue.

## 4. Booking rules

- A new check-in can be created no more than 21 days in advance.
- One stay can last no more than three calendar months.
- Occupied nights use the interval from check-in up to, but not including, check-out.
- The same house cannot have overlapping active reservations.
- Guest count cannot exceed the house capacity.
- Dates are calculated in the `Asia/Baku` time zone.

## 5. Early checkout

Open an active reservation and choose **Early checkout**. Select the actual checkout date and one of the billing policies:

- **Used nights only** recalculates accommodation and removes meals from released dates.
- **Keep full amount** releases future calendar nights but keeps the original accommodation charge.

If the prepayment becomes greater than the new total, DomBook displays the amount that must be refunded.

## 6. Calendar and reservation list

- Click a free calendar cell to start a reservation with the house and date already selected.
- Click an occupied cell to edit the existing reservation.
- Use reservation filters to show active bookings, outstanding balances or deposits.
- Cancelled and completed reservations remain in history. Permanent deletion is available only for finished or cancelled records.

## 7. Backup and data location

Open **Settings** to see the database filename and backup folder name. Full system paths are intentionally hidden for privacy; use **Open database folder** when direct access is required.

- Desktop: **Create backup** writes a verified SQLite copy with a SHA-256 checksum.
- Web: **Create backup** downloads a JSON file containing browser data.

Create a backup before major edits and copy important backups to another disk or cloud storage. A cloud folder is a backup destination, not the live database.

## 8. Language

Open **Settings → Application language** and choose Русский, Azərbaycan or English. The selection is saved for the next launch.

## 9. Troubleshooting

- **A resort is empty:** expand it and click **Add cottage**.
- **A date cannot be selected:** verify the 21-day advance window, three-month stay limit and existing reservations.
- **Meals are unavailable:** enable kitchen/restaurant service for the resort.
- **A property is missing:** enable **Show archived** and restore it if necessary.
- **Web data disappeared:** browser storage was cleared or another browser/profile is open; restore manually from your latest exported JSON backup.
