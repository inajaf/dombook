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

const MEASURE = `
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const luminance = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const parse = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (fg, fa, bg) => fg.map((c, i) => c * fa + bg[i] * (1 - fa));
  const ratio = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  // The colour actually behind the glyphs: walk up until an opaque background is found, blending
  // any translucent layers on the way. A contrast check against white alone would pass a label
  // sitting on a tinted panel.
  const effectiveBackground = (el) => {
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { stack.push(bg); if (bg.a >= 0.999) break; }
      node = node.parentElement;
    }
    let base = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i -= 1) base = blend(stack[i].rgb, stack[i].a, base);
    return base;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();

  const tooSmall = [];
  const lowContrast = [];
  for (const el of document.querySelectorAll('body *')) {
    const text = ownText(el);
    if (!text || !visible(el)) continue;
    if (el.closest('.svg-sprite')) continue;
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);
    const solid = fg.a >= 0.999 ? fg.rgb : blend(fg.rgb, fg.a, bg);
    const large = size >= 24 || (size >= 18.66 && (Number(s.fontWeight) || 400) >= 700);
    const required = large ? 3 : 4.5;
    const value = ratio(solid, bg);
    if (size < 12) tooSmall.push(Math.round(size * 10) / 10 + 'px "' + text.slice(0, 40) + '"');
    if (value < required - 0.02) lowContrast.push(Math.round(value * 100) / 100 + ':1 (needs ' + required + ') ' + size + 'px "' + text.slice(0, 40) + '"');
  }

  const tiny = [];
  for (const el of document.querySelectorAll('button, a[href], select, input:not([type=hidden]), textarea, summary, [role=button]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    // A control wrapped in its own <label> is hit through the label, which is the larger box —
    // a 20px checkbox in a 44px row is a 44px target, not a 20px one.
    const wrapper = el.closest('label');
    const box = wrapper && wrapper !== el ? wrapper.getBoundingClientRect() : r;
    if (box.height < 24 || box.width < 24) {
      tiny.push(Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + (el.innerText || el.getAttribute('aria-label') || el.type || '').trim().slice(0, 30) + '"');
    }
  }
  return { tooSmall, lowContrast, tiny };
`;

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

// --- Readability, measured on every screen -------------------------------
const problems = { tooSmall: [], lowContrast: [], tiny: [] };
for (const page of PAGES) {
  await app.evaluate(`document.querySelector('.nav-item[data-page="${page}"]').click(); return 'ok';`);
  await wait(700);
  const measured = await app.evaluate(MEASURE);
  for (const key of Object.keys(problems)) {
    problems[key].push(...measured[key].map((entry) => `${page}: ${entry}`));
  }
}
// The booking dialog is the densest screen in the product and the one a first-time owner is
// most likely to give up on, so it is measured rather than assumed to follow the rest.
await app.evaluate(`document.querySelector('.nav-item[data-page="reservations"]').click(); return 'ok';`);
await wait(500);
await app.evaluate(`document.getElementById('primaryAction').click(); return 'ok';`);
await wait(700);
const dialog = await app.evaluate(MEASURE);
for (const key of Object.keys(problems)) {
  problems[key].push(...dialog[key].map((entry) => `booking dialog: ${entry}`));
}

check(problems.tooSmall.length === 0,
  "no visible text is smaller than 12px", problems.tooSmall.slice(0, 6).join(" | "));
check(problems.lowContrast.length === 0,
  "every text colour meets its contrast floor", problems.lowContrast.slice(0, 6).join(" | "));
check(problems.tiny.length === 0,
  "no control is smaller than the 24px minimum target", problems.tiny.slice(0, 6).join(" | "));

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
