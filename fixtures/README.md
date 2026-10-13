# Shared domain fixtures

These JSON files are the **single source of truth** for DomBook's domain rules.
Both stacks load them in their test suites:

- desktop / web (Node): `tests/fixtures.test.cjs` via `require()`.
- server (Go): `server/internal/domain/fixtures_test.go` via `go:embed`.

Why: the price calculation and the booking/overlap rules are implemented twice
(JavaScript client, Go server). Without shared expectations the two
implementations drift silently and clients disagree with the server about what
is bookable. A case added here fails the build in both stacks until both agree.

## Conventions

- **Dates are pinned.** Every case receives an explicit `today`; nothing reads
  the system clock. A fixture must produce the same result on any day, in any
  timezone, or the suite is flaky and worthless.
- `dates` are plain `YYYY-MM-DD` strings (calendar dates, no time component).
- Money is in **minor units** (integer kopecks/qəpik), never floats.
- `op` selects the behavior under test; each fixture file lists its own ops.
- A case asserts either success (`"expect": { "ok": true, ... }`) or failure
  (`"expect": { "ok": false, "messageIncludes": "..." }`). Message assertions
  match on a stable substring, never the whole localized sentence.

## Files

| File | Covers |
|---|---|
| `booking-policy-cases.json` | advance window, past check-in, maximum stay, unchanged-dates skip |
| `date-math-cases.json` | `addDaysIso` and `addCalendarMonths` incl. month-end clamping |
| `plan-limit-cases.json` | per-plan unit/place quotas used by entitlement checks |

When adding a rule, add the case here first, then make both stacks pass it.
