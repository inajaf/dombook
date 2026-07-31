# DomBook Desktop

A cross-platform, fully local booking system for vacation houses and cottages.

![DomBook demo](docs/demo.gif)

## MVP features

- dashboard and a clickable availability calendar;
- CRUD for resorts: create, edit, archive and restore;
- CRUD for bookable units: cottages inside a resort and standalone houses;
- CRUD for reservations with overlap protection;
- cancel active bookings and safely (permanently) remove completed or cancelled ones;
- automatic stay calculation based on nights × nightly rate;
- separate tracking of stay cost, prepaid amount and security deposit;
- daily meal charges (breakfast / lunch / dinner) for resorts with a kitchen;
- local SQLite database;
- manual backups with SHA-256 checksums;
- multilingual interface: русский, Azərbaycan, English;
- builds for macOS, Windows and Linux.

## Getting started

```bash
npm install
npm start
```

## Tests

```bash
npm test
npm run test:smoke
```

## Where the database lives

In production the `dombook.sqlite` database is created in the Electron `userData`
directory. In development the path is shown on the Settings screen.

## How objects are organized

A `resort` (дом отдыха) is a group with a shared name and address. Inside it the
owner creates several `cottages`, and each one gets its own calendar, price and
deposit. A `standalone house` is created without a group and booked independently.

## Booking policy

- check-in can be booked up to 21 days ahead;
- a stay can span at most 3 calendar months;
- "today" is resolved in the `Asia/Baku` time zone.

## Building

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

Each installer is most reliably built on its own OS through CI:
macOS on macOS, Windows on Windows, Linux on Linux.
