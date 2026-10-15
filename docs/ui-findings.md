# Дефекты интерфейса, найденные разглядыванием приложения

Вынесено из `AGENTS.md`, который перерос бюджет инструкций и обрезался. Здесь — история и
рассуждения; правила и указатели остались в `AGENTS.md`.

## Что здесь

Layout faults that no assertion would have caught, all found by reading screenshots:

- **`.empty-state { display: grid }` beat the `hidden` attribute.** A UA `[hidden]` rule has no
  specificity over a class, so four elements stayed on screen while the renderer believed they
  were hidden: "Бронирований пока нет" above a table that HAD a booking, "Добавьте первый
  объект" above three existing properties, and two nav badges showing "0". Fixed with
  `[hidden] { display: none !important; }`. The attribute is used all over the renderer, so
  that one rule is what makes any of it work.
- **The calendar grid squeezed instead of scrolling.** `minmax(64px, 1fr)` inside a narrower
  container collapsed the day columns below their minimum and clipped the last one mid-header,
  with no way to reach it. The grid now sizes from `--calendar-days`, which the renderer sets,
  so it overflows into the scroll container instead. 15 header cells, all reachable.
- **Two CSS custom properties were used but never defined.** `--border` (conflict and rental
  cards) and `--text` (`.empty-state strong`). A custom property that does not exist makes the
  whole declaration invalid at computed-value time, so `border: 1px solid var(--border)` silently
  removed the border and every contract floated on the background as a loose white rectangle.
  Both now use `--line`/`--ink`. **Grep for this class of bug** — the one-liner is below.
- **`.empty-state` was declared twice**, and the second copy silently won the shared properties:
  a 56px empty state was rendering at 44px. Merged into one block.
- **An entrance animation can hide the content it was meant to decorate.**
  `.topbar.is-changing h1 { animation: … both }` holds the element at `opacity: 0` for the whole
  delay, and a renderer that never composites — an occluded or throttled window — leaves the page
  title and the primary button invisible. The class is now removed on `animationend` (with a
  timer fallback), so the resting state is the visible one. A new `fill-mode: both` entrance
  needs the same treatment.
- **The booking form numbered its sections in the markup.** The food section is hidden for a
  place with no kitchen, so the owner read "1 Дом и даты, 2 Гость, **4** Деньги и статус" and
  had to work out that nothing was missing. The number is a position and is now computed from
  the visible sections (`renumberReservationSections`).

### Readability is measured, not asserted

The pass for older users started from numbers rather than opinions, and the numbers are now a
suite: **`scripts/e2e-interface.mjs`** (run by `e2e-all.sh` after `branding`). It measures the
rendered page — text sizes, contrast against the *effective* background (walking up through
translucent layers), and control sizes — across all seven pages plus the booking dialog. The
baseline it was written against, and what it reads now:

| | before | after |
|---|---|---|
| visible text below 12px | 198 of 502 nodes (39%) | 0 |
| contrast failures | 9 | 0 |
| controls under 24px | 5 | 0 |

- **`--text-scale` is the whole type system.** Every size in `styles.css` is a `calc()` on it and
  nothing is set in raw px below `--text-xs`. The Settings "Размер текста" control changes that
  one value, and it lives in **localStorage, not `app_settings`**: screen size belongs to the
  device, and the server replicates `app_settings`, so syncing it would let one device enlarge
  another's interface.
- **`<small>` needs its size named.** The UA sheet renders it at `smaller` (~0.83em), which put
  every un-styled hint at 11.7px. One `small { font-size: var(--text-sm) }` covers the class.
- **A control wrapped in its own `<label>` is hit through the label.** A 20px checkbox in a 44px
  row is a 44px target; the suite measures the label, and a fix should too.
- **The Electron window reports `document.visibilityState === "hidden"` when occluded**, so a
  screenshot or measurement harness must neutralise animation first — otherwise every
  `animation-fill-mode: both` element is rasterised in its FROM state and the capture shows a
  blank title. A capture artefact, not what a user with a visible window sees.

### The timeline calendar

`src/renderer/js/views/calendar.js` draws the occupancy grid. A booking is **one bar spanning its
nights**, placed on the day cells' own CSS grid by explicit row and column, with
`pointer-events: none` so the CELL keeps the click. The earlier version repeated the guest's name
in every night cell, which made a fortnight look like fourteen separate bookings and hid where each
stay began and ended.

- **Placement goes through the CSSOM, never a `style="…"` attribute.** The page's CSP is
  `style-src 'self'`, which does not include `'unsafe-inline'`, so a style ATTRIBUTE is parsed into
  the DOM and then ignored: `getAttribute('style')` shows it while `getComputedStyle` reports
  `auto`. A bar without placement is laid out on a row of its own — still visible, still wrong —
  and `--calendar-days` set that way left the grid 14 columns wide for EVERY range, which is
  invisible while 14 is the default and wrong the moment it is not. `e2e-calendar.mjs` checks the
  computed placement and the column count for all three ranges.
- **The window is a date, not an offset.** `state.calendarStart` is an ISO day and
  `database.calendar(days, startDate)` bounds the occupancy query by it, so paging forward shows
  the next period's bookings rather than redrawing the same fortnight.
- **A stay the window cuts in half is drawn cut** (`is-cut-start` / `is-cut-end`), not as a booking
  that begins or ends at the edge.
- **The card counts the stay, not the slice of it on screen**: the nights come from the
  reservation's own dates, so a booking the window clips still reads "3 ночи" beside its real
  dates rather than the one night visible.
- **The header of «Сегодня» is the DATE**, not «Рабочий день»: a phrase that reads the same on
  every day of the year tells the reader nothing, and the weekday is what decides whether today's
  arrivals are a problem. `todayLabel()` in formatters, applied in `navigate`.
- **The range switch is a segmented control, not a `<select>`.** Three options on a toolbar are a
  view-density switch; a form control with a «Период» label reads as a setting somebody has to
  open, and its value is implied by the widget rather than stated.
- **The summary strip answers what the grid cannot.** The grid says which nights are taken;
  "how full are we" meant counting squares. Occupancy, arrivals, departures and what is still owed
  are computed from the SAME occupancy rows the bars are drawn from, so the numbers and the
  picture cannot disagree.
- **Each unit states its next free stretch** («свободно 4 ночи с 28 окт») — the question an owner
  is asked on the phone, and the one thing a grid of crosses makes you count.
- **Arrow keys page the calendar**, on the calendar page and only when nothing is focused.
- Inside a template literal, `\n` is a newline and `\D` is `D`. Two e2e blocks were written
  with single backslashes and neither failed where you would look: `/\D/g` stripped the letter D
  out of "Dev-режим" so the login code never matched, and `/\n+/g` became a regex containing a
  literal newline — a syntax error that left the harness reporting "the page reloaded". It now says
  the block never started and points at the escapes.

### The web build

`npm run check:web` builds `release/web`, serves it, boots it in a real Chromium (Electron is
already a dependency) and fails on any console error. It runs inside `check-all.sh`, which is the
only place that would have noticed the browser build being broken — `npm test` never loads a page.

- **It is the only step in `check-all.sh` that needs a DISPLAY**, and CI is headless. The Electron
  path comes from `require("electron")` rather than being assembled: a hardcoded
  `Electron.app/Contents/MacOS/Electron` failed CI on Linux with ENOENT. On Linux the check runs
  under `xvfb-run` when it is available, and otherwise reports **SKIP** and exits 0 — a check that
  cannot run must say so, not fail the build and not claim a pass. On Linux it is also started with
  `--no-sandbox`: the checkerout's `chrome-sandbox` is not setuid, so Electron aborts with
  *"The SUID sandbox helper binary was found, but is not configured correctly"*.

### A colour this suite cannot read is a colour that passes

The contrast pass reads TEXT NODES, so a field's own colour is not in it: an empty `<input>` has no
child node, its value is a property and its placeholder is a pseudo-element. A form painted
`background: white` therefore reported nothing at all while showing near-white text on white to
anyone who typed in it — in the dark theme, which is where it was noticed.

Two gaps, both closed:

- **Form fields are measured on the ELEMENT** now (`deadFields`): its own colour against its own
  background, the same 4.5:1 floor as body text.
- **`parse()` reads `color(srgb …)` as well as `rgb()`/`rgba()`.** `color-mix()` computes to the
  former, and a parser that does not know it does not fail — it returns null and the node is
  SKIPPED. So a text colour written with `color-mix()` was invisible to the whole pass.

The lesson is the general one: a measurement that silently skips what it cannot parse is worse than
no measurement, because it reports a pass. `tests/styles.test.cjs` catches the same class in a
second — no hex literal and no colour KEYWORD outside the two token blocks — and it found two more
real ones the moment it existed (a skip link whose label was white on a background that is light in
the dark theme, and a focus ring that mixed a literal white into the accent).

### Finding dead CSS tokens

```bash
grep -o "var(--[a-z0-9-]*" src/renderer/styles.css | sort -u | sed 's/var(//' > /tmp/used
grep -o "^\s*--[a-z0-9-]*:" src/renderer/styles.css | tr -d ' :' | sort -u > /tmp/def
comm -23 /tmp/used /tmp/def   # used but never defined
```

### The sidebar has two named groups

Pages are ordered by how often they are opened, not by category: **Работа** (Сегодня, Календарь,
Бронирования, **Аренда**, Объекты) then **Система** (Конфликты, Настройки). Long-term rent used
to sit in the bottom group beside Settings, which made a second revenue line with its own
contracts read as an afterthought. The placement is pinned by `e2e-interface.mjs`, so moving
"Аренда" back down fails the suite.

### Every label in the markup must exist in three languages

The Russian source string IS the translation key, so a string with no entry does not fail — it
silently stays Russian. `tests/i18n.test.cjs` extracts the text nodes and `placeholder` /
`aria-label` / `title` attributes from `index.html` and asserts az and en cover them. Scope is
the static markup only: `app.js` builds text at runtime from Russian literals, and guessing which
of those is user-facing would be a guess, not a test. The suite found twelve strings that had
never been translated, including every `<option>` label in the currency picker.

### How to actually look at the app

The `vision_*` tools (`vision_glance`, `vision_ground`, `vision_detect`, `vision_crop`,
`vision_trace`, `vision_pixel_diff`, `vision_long_screenshot_ocr`, `vision_extract_foreground`,
`vision_dominant_colors`, `vision_html_screenshot`) come from the DSH plugin
`@anionex/dsh-vision-toolkit`. Call `vision_toolkit_activate` once to expose them.

- **Coordinates are ORIGINAL image pixels**, so a `vision_ground` box feeds straight into
  `vision_crop` with no scaling in between.
- **Artifacts are written into the session workspace** under `.dsh-vision-toolkit/`, which is
  gitignored. Deleting that directory is always safe.
- **The provider is DeepSeek** (`deepseek-flash`, the only vision-capable model on that key),
  configured in `~/.dsh/profiles/web/cordis.patch.yml`, with the key held as the DSH credential
  `VISION_API_KEY`. The plugin's own default is a free public endpoint that answers HTTP 429
  under any real use, so if vision starts failing with a rate limit, that default is back —
  meaning the profile config was lost.
- **The plugin is version-exempt, and the exemption is keyed to the exact DSH version.** It is
  published for DSH `<0.2.0` while this machine runs a 0.2.x alpha, so DSH loads it only
  because an explicit exemption was granted. **A DSH upgrade invalidates it** and the tools
  stop loading. Repair with `~/.dsh/vision-setup.sh` (`--status` to check only; idempotent),
  then restart DSH.

The older `dsh-glance` / `dsh-ground` / `dsh-detect` / `dsh-crop` shell commands are gone: they
wrapped a different, now-removed plugin. Use the `vision_*` tools.
