// The occupancy timeline: what the owner reads to decide where the next booking goes.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-calendar.mjs
//
// A calendar is the one screen where a wrong answer looks like a right one, so these checks are
// about what is DRAWN: a bar that spans the nights it holds, a window that moves when it is asked
// to, and a card that agrees with the dates printed on it.

import { connect, freshStart, reporter, wait } from "./e2e-lib.mjs";

let app = await connect();
const { check, finish } = reporter("Calendar");

app = await freshStart(app);
const email = `calendar-${Date.now()}@example.test`;
const submit = (id) => app.evaluate(`
  const form = document.getElementById(${JSON.stringify(id)});
  const button = form.querySelector('button[type="submit"]');
  if (button) button.click(); else form.requestSubmit();
  return 'ok';
`);
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await submit("loginEmailForm");
await wait(3000);
const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g, '') : '';`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await submit("loginCodeForm");
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(3000);
}
const loginState = await app.evaluate(`
  return {
    workspace: document.getElementById('loginScreen').classList.contains('is-hidden'),
    codeStep: !document.getElementById('loginStepCode').hidden,
    emailError: document.getElementById('loginEmailError').hidden === false ? document.getElementById('loginEmailError').textContent : null,
    codeError: document.getElementById('loginCodeError').hidden === false ? document.getElementById('loginCodeError').textContent : null,
    hint: document.getElementById('loginCodeHint').textContent,
  };
`);
check(loginState.workspace, "signed in", JSON.stringify(loginState));

// --- A stay that crosses the window, and one that fits inside it ----------
const seeded = await app.evaluate(`
  const bridge = window.domBook;
  const today = (await bridge.system.info()).data.bookingPolicy.today;
  const add = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const unit = (await bridge.properties.list()).data[0];
  const short = await bridge.reservations.create({ propertyId: unit.id, guestName: 'Короткая бронь', status: 'hold',
    checkInDate: add(today, 1), checkOutDate: add(today, 4), prepaidMinor: 0, depositMinor: 0, depositStatus: 'none',
    adults: 2, children: 0, totalMinor: 0 });
  // Starts inside the window and ends past it, so the bar must be drawn cut rather than as a stay
  // that finishes where the calendar happens to stop.
  const long = await bridge.reservations.create({ propertyId: unit.id, guestName: 'Долгая бронь', status: 'confirmed',
    checkInDate: add(today, 6), checkOutDate: add(today, 40), prepaidMinor: 0, depositMinor: 0, depositStatus: 'none',
    adults: 2, children: 0, totalMinor: 0 });
  await refreshCore();
  return { short: short.ok, long: long.ok, today };
`);
check(seeded.short && seeded.long, "two stays exist to draw", JSON.stringify(seeded));

await app.evaluate(`document.querySelector('.nav-item[data-page="calendar"]').click(); return 'ok';`);
await wait(900);

const drawn = await app.evaluate(`
  const bars = [...document.querySelectorAll('.timeline-bar')].map((bar) => ({
    guest: bar.querySelector('.timeline-bar-guest').textContent,
    status: bar.className.match(/\b(hold|confirmed|checked_in|checked_out|conflict)\b/)?.[1],
    row: getComputedStyle(bar).gridRow,
    column: getComputedStyle(bar).gridColumn,
    cutEnd: bar.classList.contains('is-cut-end'),
    nights: Number(bar.dataset.runTo) - Number(bar.dataset.runFrom) + 1,
  }));
  const cells = document.querySelectorAll('.calendar-night').length;
  const columns = getComputedStyle(document.querySelector('.calendar-grid')).gridTemplateColumns.split(' ').length;
  return { bars, cells, columns };
`);
const short = drawn.bars.find((bar) => bar.guest === "Короткая бронь");
const long = drawn.bars.find((bar) => bar.guest === "Долгая бронь");
check(Boolean(short) && short.nights === 3, "a three-night stay is one bar three nights wide", JSON.stringify(short));
// Placed on the day cells' own row, not on a row of its own: a bar that falls out of the grid is
// still visible and still wrong, which is exactly how it shipped once.
check(short?.row === "2", "the bar is on the row of the unit it belongs to", `row=${short?.row}`);
check(/^\d+ \/ \d+$/.test(short?.column || ""), "and spans explicit day columns", `column=${short?.column}`);
check(long?.cutEnd === true, "a stay that runs past the window is drawn as cut, not as finished");
check(drawn.cells === 14, "14 days of cells for a 14-day window", `cells=${drawn.cells}`);
check(drawn.columns === 15, "and a grid of 14 days plus the unit column", `columns=${drawn.columns}`);

// --- Moving the window ----------------------------------------------------
const rangeLabel = () => app.evaluate(`return document.querySelector('.calendar-nav-range').textContent`);
const before = await rangeLabel();
await app.evaluate(`document.querySelector('[data-calendar-nav="1"]').click(); return 'ok';`);
await wait(900);
const after = await rangeLabel();
check(after !== before, "the next period moves the window", `${before} -> ${after}`);
const moved = await app.evaluate(`
  return { bars: document.querySelectorAll('.timeline-bar').length,
    days: getComputedStyle(document.querySelector('.calendar-grid')).gridTemplateColumns.split(' ').length };
`);
check(moved.days === 15, "the window keeps its width when it moves", `columns=${moved.days}`);

await app.evaluate(`document.querySelector('[data-calendar-nav="today"]').click(); return 'ok';`);
await wait(900);
check((await rangeLabel()) === before, "and «Сегодня» comes back to it", `${await rangeLabel()}`);

// --- The range selector ---------------------------------------------------
// `--calendar-days` reached the grid through a style ATTRIBUTE once, which this page's CSP drops:
// the grid stayed 14 days wide for every choice, which is invisible while 14 is the default.
for (const [value, expected] of [["21", 22], ["30", 31], ["14", 15]]) {
  await app.evaluate(`
    const select = document.getElementById('calendarRange');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  `);
  await wait(900);
  const columns = await app.evaluate(`return getComputedStyle(document.querySelector('.calendar-grid')).gridTemplateColumns.split(' ').length`);
  check(columns === expected, `choosing ${value} days redraws the grid ${expected} columns wide`, `columns=${columns}`);
}

// --- The hover card -------------------------------------------------------
const card = await app.evaluate(`
  const cell = document.querySelector('.calendar-night[data-calendar-reservation]');
  cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const popover = document.getElementById('calendarPopover');
  const box = popover.getBoundingClientRect();
  return { hidden: popover.hidden, text: popover.innerText.replace(/\\n+/g, ' | '),
    onScreen: box.left >= 0 && box.top >= 0 && box.width > 120 };
`);
check(card.hidden === false && card.onScreen, "hovering a booking shows a card on screen");
check(/Короткая бронь/.test(card.text), "the card names the guest", card.text.slice(0, 60));
check(/3 ночи/.test(card.text), "and counts the nights of the stay", card.text.slice(0, 90));
check(/Оплата/.test(card.text), "and says what is owed", card.text.slice(0, 120));

// --- Clicking a free night starts a booking on that night -----------------
const clicked = await app.evaluate(`
  const free = document.querySelector('.calendar-night.is-free');
  const date = free.dataset.calendarDate;
  free.click();
  await new Promise((r) => setTimeout(r, 700));
  const dialog = document.getElementById('reservationDialog');
  return { date, open: dialog.open, checkIn: dialog.querySelector('[name="checkInDate"]')?.value };
`);
check(clicked.open === true, "clicking a free night opens the booking dialog");
check(clicked.checkIn === clicked.date, "and starts it on the night that was clicked", `${clicked.checkIn} vs ${clicked.date}`);
await app.evaluate(`document.getElementById('reservationDialog').close(); return 'ok';`);

const ok = finish();
console.log(ok ? "CALENDAR OK" : "CALENDAR FAILED");
app.close();
process.exit(ok ? 0 : 1);
