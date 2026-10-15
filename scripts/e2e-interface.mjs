// What the interface looks like to the person using it.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-interface.mjs
//
// Every other suite asserts behaviour: a booking is stored, a tenant cannot read another's rows,
// a push reaches PostgreSQL. None of them can see the three faults this file exists for, and all
// three were measured on the real app rather than guessed at:
//
//   - the sidebar put "Аренда" — a second revenue line with its own contracts — in the bottom
//     group next to Settings, so it read as an afterthought;
//   - 39% of the visible text was set below 12px, down to 9px on the calendar, and nine text
//     nodes failed the 4.5:1 contrast floor;
//   - the smallest control in the product was a 17x17 checkbox.
//
// The measurements are taken from the rendered page, not from the stylesheet, because that is
// what a user has in front of them: a declared size proves nothing about what was laid out.

import {connect, freshStart, reporter, wait} from "./e2e-lib.mjs";

let app = await connect();
const { check, finish } = reporter("Interface");

// Sign in. This suite needs the workspace, not the login screen, and a fresh account keeps it
// independent of what the suites before it left behind.
const email = `interface-${Date.now()}@example.test`;
app = await freshStart(app);
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await app.evaluate(`document.getElementById('loginEmailForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(3000);
const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g,'') : '';`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await app.evaluate(`document.getElementById('loginCodeForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(2500);
}

// Motion off for the duration of the run.
//
// A CSS animation that has not been composited holds its element in the FROM state, and the
// window this suite drives reports document.visibilityState === "hidden" whenever it is
// occluded — so an element that enters with `opacity: 0` measures as transparent and a rotated
// or scaled element measures at its start size. Neither is what a visible window shows, and both
// would make these numbers depend on what else is on the desktop.
await app.evaluate(`
  const style = document.createElement('style');
  style.id = 'e2e-no-motion';
  style.textContent = '*,*::before,*::after{animation:none !important;transition:none !important}';
  document.head.appendChild(style);
  return 'ok';
`);

import { MEASURE_SOURCE as MEASURE } from "./lib/measure.mjs";

const PAGES = ["dashboard", "calendar", "reservations", "properties", "rentals", "conflicts", "settings"];

// --- The sidebar, which is what the regrouping was about ------------------
const nav = await app.evaluate(`
  return [...document.querySelectorAll('.sidebar .nav-item')].map((el) => ({
    page: el.dataset.page,
    label: el.innerText.trim().split('\\n')[0],
    group: el.closest('nav').className.includes('nav-secondary') ? 'system' : 'work',
  }));
`);
const order = nav.map((item) => item.page).join(",");
check(order === "dashboard,calendar,reservations,rentals,properties,conflicts,settings",
  "the sidebar is ordered by how often each page is opened", order);
check(nav.find((item) => item.page === "rentals")?.group === "work",
  "long-term rent sits with the working pages, not next to Settings");
check(nav.filter((item) => item.group === "work").length === 5,
  "the working group holds the five daily pages");
const groupLabels = await app.evaluate(`
  return [...document.querySelectorAll('.sidebar .nav-group-title')].map((el) => el.textContent.trim());
`);
check(JSON.stringify(groupLabels) === JSON.stringify(["Работа", "Система"]),
  "both groups are named, so the split reads as two sections", JSON.stringify(groupLabels));

// --- Readability, measured on every screen, in BOTH themes ---------------
//
// The dark palette is a second set of sixty roles, and a role that was chosen for how it looks
// rather than for what it measures is unreadable in the one theme nobody checked. So the suite
// walks every screen twice, once per theme: the same floor applies to both, and the theme is
// switched through the control the owner uses rather than by setting an attribute behind the UI.
async function measureEveryScreen(themeName) {
  const problems = { tooSmall: [], lowContrast: [], tiny: [], deadFields: [] };
  for (const page of PAGES) {
    await app.evaluate(`document.querySelector('.nav-item[data-page="${page}"]').click(); return 'ok';`);
    await wait(700);
    const measured = await app.evaluate(MEASURE);
    for (const key of Object.keys(problems)) {
      problems[key].push(...measured[key].map((entry) => `${themeName} ${page}: ${entry}`));
    }
  }
  return problems;
}

const setTheme = async (choice) => {
  // Through the Settings control: it is the one the owner has, and it goes through localStorage
  // and the pre-paint bootstrap exactly as a real switch does.
  await app.evaluate(`document.querySelector('.nav-item[data-page="settings"]').click(); return 'ok';`);
  await wait(400);
  await app.evaluate(`
    const select = document.getElementById('themeSelect');
    select.value = ${JSON.stringify(choice)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return document.documentElement.dataset.theme;
  `);
  await wait(400);
  return app.evaluate(`return document.documentElement.dataset.theme`);
};

check((await setTheme("light")) === "light", "the Settings control switches to the light theme");
const lightProblems = await measureEveryScreen("light");
const lightDialog = await measureBookingDialog("light");

// Dark, measured the same way. The sidebar is dark in both themes, so a fault there is a fault in
// the light pass; what this pass is for is every card, table, input and dialog.
check((await setTheme("dark")) === "dark", "and to the dark theme");
const darkProblems = await measureEveryScreen("dark");
const darkDialog = await measureBookingDialog("dark");
// The booking dialog is the densest screen in the product and the one a first-time owner is
// most likely to give up on, so it is measured rather than assumed to follow the rest — and in
// both themes, because it is drawn after the theme pass and would otherwise be measured in
// whichever one happened to be left on.
async function measureBookingDialog(themeName) {
  const found = { tooSmall: [], lowContrast: [], tiny: [], deadFields: [] };
  await app.evaluate(`document.querySelector('.nav-item[data-page="reservations"]').click(); return 'ok';`);
  await wait(500);
  await app.evaluate(`document.getElementById('primaryAction').click(); return 'ok';`);
  await wait(700);
  const measured = await app.evaluate(MEASURE);
  for (const key of Object.keys(found)) {
    found[key].push(...measured[key].map((entry) => `${themeName} booking dialog: ${entry}`));
  }
  await app.evaluate(`
    const dialog = document.getElementById('reservationDialog');
    if (dialog?.open) dialog.close();
    return 'ok';
  `);
  await wait(300);
  return found;
}

const bothThemes = (key) => [
  ...lightProblems[key], ...lightDialog[key], ...darkProblems[key], ...darkDialog[key],
];
check(bothThemes("tooSmall").length === 0,
  "no visible text is smaller than 12px, in either theme", bothThemes("tooSmall").slice(0, 6).join(" | "));
check(bothThemes("lowContrast").length === 0,
  "every text colour meets its contrast floor, in either theme",
  bothThemes("lowContrast").slice(0, 6).join(" | "));
check(bothThemes("tiny").length === 0,
  "no control is smaller than the 24px minimum target, in either theme",
  bothThemes("tiny").slice(0, 6).join(" | "));
// A form field is where a person types, and near-white text on a white field is invisible exactly
// while it matters. An empty input has no text node, so this is measured on the ELEMENT.
check(bothThemes("deadFields").length === 0,
  "every form field's own text is readable against its own background, in either theme",
  bothThemes("deadFields").slice(0, 6).join(" | "));

// The switch has to survive a restart, and it has to be applied BEFORE the first paint — a window
// that paints light and turns dark reads as a fault rather than as a preference.
const storedTheme = await app.evaluate(`
  return { stored: localStorage.getItem('rentkeeper.theme'), applied: document.documentElement.dataset.theme };
`);
check(storedTheme.stored === "dark", "the chosen theme is remembered on this device", String(storedTheme.stored));

// --- The sections of the booking form are numbered as shown ---------------
// The food section is hidden for a place without a kitchen, and the numbers used to be typed
// into the markup — so the owner read 1, 2, 4 and wondered what they had missed.
const numbering = await app.evaluate(`
  return [...document.querySelectorAll('#reservationForm .form-section')]
    .filter((section) => !section.hidden)
    .map((section) => section.querySelector('h3 span')?.textContent ?? '');
`);
check(numbering.join(",") === numbering.map((_, index) => index + 1).join(","),
  "the booking form numbers its visible sections without a gap", numbering.join(","));
await app.evaluate(`document.getElementById('reservationDialog').close(); return 'ok';`);

// --- The text-size preference -------------------------------------------
await app.evaluate(`document.querySelector('.nav-item[data-page="settings"]').click(); return 'ok';`);
await wait(600);
const before = await app.evaluate(`return parseFloat(getComputedStyle(document.body).fontSize);`);
await app.evaluate(`
  const select = document.getElementById('textScale');
  select.value = 'xlarge';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
`);
await wait(400);
const enlarged = await app.evaluate(`
  return {
    body: parseFloat(getComputedStyle(document.body).fontSize),
    stored: localStorage.getItem('rentkeeper.interface-scale'),
  };
`);
check(enlarged.body > before, "choosing a larger text size enlarges the interface",
  `${before}px -> ${enlarged.body}px`);
check(enlarged.stored === "xlarge", "the choice is remembered on this device", String(enlarged.stored));

// It has to survive a reload, which is the only way the preference is worth having: the reader
// sets it once and expects every later launch to be readable.
await app.send("Page.reload", { ignoreCache: true });
await wait(3000);
const afterReload = await app.evaluate(`
  return {
    body: parseFloat(getComputedStyle(document.body).fontSize),
    selected: document.getElementById('textScale')?.value,
  };
`);
check(afterReload.body === enlarged.body, "the larger text survives a restart", `${afterReload.body}px`);
check(afterReload.selected === "xlarge", "the settings panel shows the stored choice", String(afterReload.selected));

// Put it back, so the next suite starts from the shipped appearance.
await app.evaluate(`
  const select = document.getElementById('textScale');
  if (select) { select.value = 'normal'; select.dispatchEvent(new Event('change', { bubbles: true })); }
  return 'ok';
`);

const ok = finish();
console.log(ok ? "INTERFACE OK" : "INTERFACE FAILED");
app.close();
process.exit(ok ? 0 : 1);
