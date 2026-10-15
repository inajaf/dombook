// Realistic user scenarios, driven through the actual UI.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-scenarios.mjs
//
// Each scenario is what a person would do, in the order they would do it. The point is to
// exercise the assembled product — renderer, IPC, main process, PostgreSQL, sync engine —
// rather than any layer in isolation.

import {addDays, addMonths, connect, freshStart, reporter, resetAuthState, restartApp, wait} from "./e2e-lib.mjs";

let app = await connect();
const { check, finish } = reporter("Scenarios");

const email = `owner-${Date.now()}@example.test`;
const submit = (formId) => app.evaluate(`
  const f = document.getElementById(${JSON.stringify(formId)});
  const b = f.querySelector('button[type="submit"]');
  if (b) b.click(); else f.requestSubmit();
  return 'ok';
`);
const go = async (page) => {
  await app.evaluate(`document.querySelector('.nav-item[data-page="${page}"]').click(); return 'ok';`);
  await wait(800);
};

// --- Scenario 1: a new owner signs up -------------------------------------
app = await freshStart(app);
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await submit("loginEmailForm");
await wait(3000);
check(await app.evaluate(`return !document.getElementById('loginStepCode').hidden`), "a new owner reaches the code step");

const code = await app.evaluate(`
  const h = document.getElementById('loginCodeHint');
  return h && !h.hidden ? h.textContent.replace(/\\D/g, '') : '';
`);
check(code.length === 6, "the code arrives", `code=${code}`);

await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await submit("loginCodeForm");
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(3000);
}
check(await app.evaluate(`return document.getElementById('loginScreen').classList.contains('is-hidden')`), "the workspace opens");

const account = await app.evaluate(`return (await window.domBook.auth.status()).data.session?.accountName`);
check(Boolean(account), "the account is named", `account=${account}`);

// --- Scenario 2: the owner reviews the starting state ---------------------
await go("dashboard");
const dashboard = await app.evaluate(`
  const r = await window.domBook.dashboard.get();
  return { hasData: Boolean(r.data), properties: (await window.domBook.properties.list()).data.length };
`);
check(dashboard.hasData, "the dashboard loads", `seeded units=${dashboard.properties}`);

// The demo seed gives a realistic starting point rather than an empty app.
check(dashboard.properties > 0, "the app starts with sample data to explore");

// --- Scenario 3: add a guest house, then a unit inside it -----------------
await go("properties");
await app.evaluate(`
  const f = document.getElementById('placeForm');
  f.reset();
  f.elements.name.value = 'База у моря';
  f.elements.address.value = 'Баку, Приморский бульвар';
  f.elements.hasFoodService.checked = true;
  return 'ok';
`);
await submit("placeForm");
await wait(2000);
const place = await app.evaluate(`
  const r = await window.domBook.places.list();
  return (r.data || []).find((p) => p.name === 'База у моря') || null;
`);
check(Boolean(place), "a guest house is created from the form");
check(place?.has_food_service === 1 || place?.has_food_service === true, "the food-service flag is stored");

await app.evaluate(`
  const f = document.getElementById('propertyForm');
  f.reset();
  f.elements.name.value = 'Коттедж у моря';
  f.elements.capacity.value = '5';
  f.elements.basePrice.value = '120';
  f.elements.monthlyRate.value = '1500';
  f.elements.deposit.value = '200';
  return 'ok';
`);
await submit("propertyForm");
await wait(2000);
const unit = await app.evaluate(`
  const r = await window.domBook.properties.list();
  return (r.data || []).find((p) => p.name === 'Коттедж у моря') || null;
`);
check(unit?.base_price_minor === 12000, "the nightly price is stored in minor units", `base=${unit?.base_price_minor}`);
check(unit?.monthly_rate_minor === 150000, "the monthly price is stored", `monthly=${unit?.monthly_rate_minor}`);
check(unit?.deposit_minor === 20000, "the deposit is stored", `deposit=${unit?.deposit_minor}`);

// --- Scenario 4: signing in again is not signing up ----------------------
// The plan picker used to be shown to anyone whose plan read "free", which is every account that
// has not bought the paid tier — so a returning owner was asked to choose a tariff on every single
// sign-in, and a colleague who had just accepted an invitation was asked on their first. The
// question had already been answered, and a screen that asks it again reads as a gate.
await go("settings");
await app.evaluate(`document.getElementById('logoutButton').click(); return 'ok';`);
await wait(2500);

const signOut = await app.evaluate(`
  return { loginVisible: !document.getElementById('loginScreen').classList.contains('is-hidden'),
    step: ['loginStepEmail','loginStepCode','loginStepPlan'].find((id) => !document.getElementById(id).hidden) || null };
`);
check(signOut.loginVisible && signOut.step === "loginStepEmail", "signing out returns to the start of the flow", JSON.stringify(signOut));

await app.evaluate(`
  const f = document.getElementById('loginEmailForm');
  f.elements.loginEmail.value = ${JSON.stringify(email)};
  f.querySelector('button[type=submit]').click();
  return 'ok';
`);
await wait(3500);
const secondCode = await app.evaluate(`
  const h = document.getElementById('loginCodeHint');
  return h && !h.hidden ? h.textContent.replace(/\\D/g, '') : '';
`);
check(secondCode.length === 6, "the code arrives for a second sign-in", `code=${secondCode}`);

await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(secondCode)}; return 'ok';`);
await submit("loginCodeForm");
// Long enough for the plan step to have appeared if it were going to: it renders in the same tick
// as the session is applied.
await wait(4000);
const secondEntry = await app.evaluate(`
  return { planShown: !document.getElementById('loginStepPlan').hidden,
    workspace: document.getElementById('loginScreen').classList.contains('is-hidden') };
`);
check(!secondEntry.planShown, "an existing account is NOT asked to choose a plan again", JSON.stringify(secondEntry));
check(secondEntry.workspace, "and it goes straight into the app", JSON.stringify(secondEntry));

const ok = finish();
console.log(ok ? "SCENARIOS OK" : "SCENARIOS FAILED");
app.close();
process.exit(ok ? 0 : 1);
