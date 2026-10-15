# End-to-end сьюты: история и ловушки

Вынесено из `AGENTS.md`. Здесь подробности и разборы; в `AGENTS.md` — список сьютов и правила.

## Что здесь

`scripts/e2e-all.sh` brings up the stack and drives the actual Electron app over CDP. These exist
because every serious bug in this project was invisible to both unit suites:

- **`e2e-scenarios.mjs`** — signup, the plan step, a guest house and a unit.
- **`e2e-booking.mjs`** — a stay through the dialog, its nights on the calendar, overlap
  refused, back-to-back allowed, capacity enforced.
- **`e2e-branding.mjs`** — the product name as rendered, in three locales and both windows.
- **`e2e-interface.mjs`** — the sidebar's grouping, and the readability floor measured on the
  rendered page (text sizes, contrast, control sizes) across every screen.
- **`e2e-pricing.mjs`** — a season and a discount reaching the dialog, the amount and its
  breakdown being stored, a negotiated amount overriding the calculation, and the unit dialog
  keeping the values it does not show.
- **`e2e-documents.mjs`** — a contract and an invoice written as real PDF files, checked for a
  PDF header, a plausible size and a PAGE COUNT, plus the requisites they print.
- **`e2e-calendar.mjs`** — the timeline: one bar per stay spanning the nights it holds, a window
  that pages, the 14/21/30 range actually resizing the grid, the hover card, and a booking started
  by clicking a free night.
- **`e2e-operations.mjs`** — check-in, early checkout, cancel, delete, archive/restore, backup.
- **`e2e-security.mjs`** — two tenants; neither can read, write or book into the other's data,
  and the signed-out bridge refuses everything.
- **`e2e-sync.mjs`** — a real push and pull, with the nights confirmed in PostgreSQL.

### The harness must never replay a block (this was the flake)

`evaluate()` in `scripts/e2e-lib.mjs` collected a block's result by awaiting its promise over CDP.
Chrome DROPS that promise when the renderer is busy — `Promise was collected` — which is
indistinguishable from a crash, so the harness retried the block. **A retry replays everything the
block did.** A block that created a booking and then redrew re-ran its create, and the second
attempt was refused as *"уже занят"* by the row the FIRST attempt had just written. The suite then
reported a product fault — a booking colliding with a row the run never created, an early checkout
refused because the row it had just checked in was not active — while the product was correct. It
was intermittent, because it depended on how busy the renderer happened to be.

That is the shape of the failure this file carried as unexplained: *"a booking refused as already
occupied by a row the suite never created, which looks exactly like a product bug"*, and the
cancel-block cascade below. It was diagnosed by logging every retry and reading the app's own error
log, which showed the create being refused **by the row the same run had just made**.

The harness now gives each block a token, starts it, and POLLS `window[token]` for the result. The
block runs exactly once whatever the inspector does with the promise, and a navigation is reported
as a navigation instead of being retried into a false pass. **Do not reintroduce a retry.**

### Writing one: the traps, all of which cost real time here

- **Use `freshStart(appHdl)`, never `resetAuthState()` alone.** The app holds its database in
  memory and rewrites the file on exit, so deleting the profile under a running app leaves the
  old data on disk moments later. `freshStart` stops the app, waits for the CDP port to free,
  clears the server AND the profile, then starts a new app.
- **The server keeps the previous run's data.** `resetAuthState` truncates `users, accounts, …`
  `CASCADE`, which reaches the tenant tables through their account FK. Clearing only the auth
  tables leaves the old bookings on the server; the fresh client pulls them back down and its
  rows then collide — a booking refused as "already occupied" by a row the suite never created.
- **Never reuse fixed date offsets.** The operations suite derived `today+2..today+5`, and a
  leftover row from an earlier run made a correct booking look broken. It now picks the first
  free window from live occupancy and re-reads the booking's real dates for every later step.
- **...including in the ASSERTION, not just in the setup.** The same suite picked its booking's
  dates from live occupancy but then asserted occupancy over a fixed `today+2..today+5`. That
  window is the booking's own only when the free-window search lands on offset 2; on a clean
  database it lands on offset 1, and the check counted two of three nights and failed while the
  behaviour it named was correct. It passed historically for a reason unrelated to what it
  asserts — leftover nights from an earlier run pushed the search to a later offset. The check now
  uses the booking's own dates. Deriving the fixture and hard-coding the expectation is not
  deriving the fixture.
- **Each suite creates its own place and unit, timestamped**, rather than sharing the demo seed.
- **The renderer caches the unit list.** A unit created through the bridge is invisible to a
  dialog until `refreshCore()` runs, exactly as the app does after a form submit. Skipping it
  leaves a required `<select>` with no matching option, and the submit silently does nothing.

### The cancel block: a cascade that hid its own cause

`e2e-operations.mjs` failed once in a full `e2e-all.sh` run, with FOUR consecutive checks red
from *"a second booking exists"* onward, and passed every other time. Two defects in that block
made the failure unreadable, and both are fixed:

- **The unit creation was never checked.** The block created `Отмена-<stamp>` and returned
  `unit.data?.id` without looking at `unit.ok`, so a failed create produced `undefined`, the
  booking below failed, and the three checks after it failed with it. One discarded error
  presented as four product bugs. There is now a check on that create that prints its error,
  the entitlement allowance, the place id and how many rows carry the new name.
- **The dates were fixed offsets** (`today+10..today+12`), the last such block in the file and
  the one pattern the section above warns about. The window now comes from live occupancy, the
  same way the earlier check-in block finds its dates.

Both refusal modes were then induced against the running app to confirm the diagnostics
separate them:

| Cause | Error the suite now surfaces |
|---|---|
| the unit is not there | `Дом: неверный идентификатор` |
| the unit is there, the dates are refused | `Заезд можно оформить максимум на 21 день вперёд — до <date>` |

**The original failure was never reproduced** — 5 isolated runs and 4 full `e2e-all.sh` runs, 9
in total, all green. Its cause was found later and it was NOT in the product: see *"The harness
must never replay a block"* above. The retry replayed a write, so the suite created a row twice and
reported the collision as a booking made by a previous run. The hardening in this section is what
made the failure name its cause on the spot instead of cascading.

**The entitlement cap was ruled out, and the counter-evidence is worth keeping.** The first
hypothesis was that the free tier's 1-unit cap refused the create. It cannot have: there is no
gate to refuse it. `unitAllowance`/`unitAllowanceStatus` only *report*, `createProperty` never
reads them, and the renderer's only use is an upgrade banner (`overLimit`). The measurements say
the same — an account holding **3 active units on an allowance of 1** (`over: true`) shows three
units existing and not one write refused. That is the documented design (the server owns
enforcement so a licensed user offline is never locked out), so a unit-cap refusal is not a
candidate for any e2e failure in this project.
