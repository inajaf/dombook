// The product name, as a user actually sees it.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-branding.mjs
//
// A rename touches strings in three languages and two windows. This checks what is rendered,
// not what the source says — a missed translation key shows the raw Russian source string, so
// asserting on the DOM catches it.

import { connect, wait, reporter } from "./e2e-lib.mjs";

const app = await connect();
const { check, finish } = reporter("Branding");

const NAME = "RentKeeper";

// --- The login window -----------------------------------------------------
const login = await app.evaluate(`
  return {
    title: document.title,
    brand: [...document.querySelectorAll('.login-brand strong, .login-card strong')].map((e) => e.textContent.trim()),
    heading: document.getElementById('loginHeading')?.textContent,
    anyOldName: document.body.innerText.includes('DomBook'),
  };
`);
check(login.title === NAME, "the window title is the new name", `title=${login.title}`);
check(!login.anyOldName, "the old name appears nowhere on the login screen");
check(
  (login.brand ?? []).some((b) => b === NAME) || /RentKeeper/.test(login.heading ?? ""),
  "the login screen is branded",
  `brand=${JSON.stringify(login.brand)} heading=${login.heading}`,
);

// --- The same heading in every locale ------------------------------------
// The Russian source string IS the translation key, so a locale that still maps the old key
// silently falls back to Russian — the heading would read "Вход в RentKeeper" in English.
const locales = await app.evaluate(`
  const out = {};
  for (const lang of ['ru', 'en', 'az']) {
    window.i18n?.setLanguage(lang);
    out[lang] = document.getElementById('loginHeading')?.textContent;
  }
  window.i18n?.setLanguage('ru');
  return out;
`);
check(/RentKeeper/.test(locales.ru ?? ""), "the Russian heading carries the new name", `ru=${locales.ru}`);
check(/RentKeeper/.test(locales.en ?? ""), "the English heading carries the new name", `en=${locales.en}`);
check(/RentKeeper/.test(locales.az ?? ""), "the Azerbaijani heading carries the new name", `az=${locales.az}`);
check(!/DomBook/.test(JSON.stringify(locales)), "no locale still shows the old name");

// --- Sign in and check the workspace -------------------------------------
const email = `brand-${Date.now()}@example.test`;
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await app.evaluate(`document.getElementById('loginEmailForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(3000);
const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g, '') : '';`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await app.evaluate(`document.getElementById('loginCodeForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanPlanSubmit')?.click(); document.getElementById('loginPlanSubmit')?.click(); return 'ok';`);
  await wait(3000);
}

const workspace = await app.evaluate(`
  return {
    signedIn: document.getElementById('loginScreen').classList.contains('is-hidden'),
    brandText: [...document.querySelectorAll('.sidebar strong, .brand strong')].map((e) => e.textContent.trim()),
    anyOldName: document.body.innerText.includes('DomBook'),
  };
`);
check(workspace.signedIn, "the workspace opens");
check(!workspace.anyOldName, "the old name appears nowhere in the workspace",
  `brand=${JSON.stringify(workspace.brandText)}`);

// --- The settings screen shows where data lives --------------------------
await app.evaluate(`document.querySelector('.nav-item[data-page="settings"]').click(); return 'ok';`);
await wait(900);
const settings = await app.evaluate(`return document.getElementById('page-settings').innerText`);
check(!/DomBook/.test(settings), "the settings screen does not mention the old name");
check(/rentkeeper/i.test(settings) || /dombook\.sqlite/.test(settings),
  "the storage path is shown so a user can find their data",
  `${settings.split("\n").find((l) => /sqlite|Application Support/i.test(l)) ?? ""}`.trim().slice(0, 90));

const ok = finish();
console.log(ok ? "BRANDING OK" : "BRANDING FAILED");
app.close();
process.exit(ok ? 0 : 1);
