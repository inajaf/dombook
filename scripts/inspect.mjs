#!/usr/bin/env node
/**
 * The inspection CLI: the questions an agent asks a RUNNING app, answered mechanically.
 *
 *   node scripts/inspect.mjs <command> [args]
 *
 * WHY THIS EXISTS
 *
 * Every one of these questions was asked repeatedly during the work that built this product, and
 * every time it was answered by a hand-written probe script in /tmp: read the page, read a
 * computed style, measure contrast, check the module graph, look at the sync state, take a
 * screenshot. Thirteen of those probes existed at once, each slightly different, none of them
 * reusable, none of them reviewed.
 *
 * That is the failure this replaces. An agent should not invent how to look at a page each time it
 * needs to look at a page: the JUDGEMENT is the agent's, the MECHANICS belong in a rigid tool with
 * a fixed output shape. The output is JSON so that reading it is parsing, not scraping.
 *
 * The app must be running with its debug port open (the e2e stack does that, and `npm start` can:
 * see AGENTS.md). Commands that only read files (imports, palette) work without it.
 */

import { connect, wait } from "./e2e-lib.mjs";
import { MEASURE_SOURCE } from "./lib/measure.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["dashboard", "calendar", "reservations", "properties", "rentals", "conflicts", "settings"];

const out = (value) => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
const fail = (message, hint) => {
  process.stderr.write(`inspect: ${message}${hint ? `\n  ${hint}` : ""}\n`);
  process.exit(1);
};

async function withApp(fn) {
  let app;
  try {
    app = await connect();
  } catch (error) {
    fail(error.message, "Приложение не отвечает на порту 9555. Запустите его: npm start");
  }
  try {
    return await fn(app);
  } finally {
    app.close();
  }
}

const commands = {
  /**
   * What is attached and what it is showing. The first command of any session: everything else
   * assumes the app is up and signed in.
   */
  async status() {
    return withApp(async (app) => {
      const state = await app.evaluate(`
        const bridge = window.domBook;
        const auth = await bridge.auth.status();
        const screen = document.getElementById('loginScreen');
        return {
          signedIn: screen ? screen.classList.contains('is-hidden') : null,
          account: auth.data?.session?.accountName || null,
          email: auth.data?.session?.user?.email || null,
          page: document.querySelector('.nav-item.active')?.dataset.page || null,
          theme: document.documentElement.dataset.theme || null,
          textScale: getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim(),
          counts: window.state ? {
            places: window.state.places.length,
            units: window.state.properties.length,
            reservations: window.state.reservations.length,
          } : null,
        };
      `);
      return state;
    });
  },

  /** Every module of the renderer graph, imported. A missing export blanks the whole window. */
  async imports() {
    return withApp(async (app) => {
      return app.evaluate(`
        const names = ['dom','formatters','theme','toast','modal','store','api','runtime',
          'views/calendar','views/dashboard','views/reservations','views/properties',
          'views/rentals','views/conflicts','views/settings','app'];
        const results = {};
        for (const name of names) {
          try { await import('./js/' + name + '.js?v=' + Date.now()); results[name] = 'ok'; }
          catch (error) { results[name] = String(error).slice(0, 200); }
        }
        return results;
      `);
    });
  },

  /** Go to a page and report what it rendered: the visible text, trimmed to a readable size. */
  async page(name) {
    if (!PAGES.includes(name)) fail(`неизвестная страница «${name}»`, `есть: ${PAGES.join(", ")}`);
    return withApp(async (app) => {
      await app.evaluate(`document.querySelector('.nav-item[data-page="${name}"]').click(); return 'ok';`);
      await wait(900);
      return app.evaluate(`
        const section = document.getElementById('page-${name}');
        return {
          page: ${JSON.stringify(name)},
          eyebrow: document.getElementById('pageEyebrow').textContent,
          title: document.getElementById('pageTitle').textContent,
          text: section ? section.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 4000) : null,
        };
      `);
    });
  },

  /** The text of one element, by CSS selector. */
  async text(selector) {
    if (!selector) fail("нужен селектор", "node scripts/inspect.mjs text '#pageTitle'");
    return withApp(async (app) => {
      return app.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false, selector: ${JSON.stringify(selector)} };
        return { found: true, selector: ${JSON.stringify(selector)}, text: el.innerText, box: (() => {
          const r = el.getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
        })() };
      `);
    });
  },

  /**
   * Computed styles of an element. This is the question that hand-written probes got wrong most
   * often: `getAttribute('style')` shows what was ASKED for, `getComputedStyle` shows what the
   * page actually used, and under this CSP they differ.
   */
  async style(selector, ...properties) {
    if (!selector) fail("нужен селектор", "node scripts/inspect.mjs style '.field input' backgroundColor color");
    return withApp(async (app) => {
      return app.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false, selector: ${JSON.stringify(selector)} };
        const wanted = ${JSON.stringify(properties)};
        const computed = getComputedStyle(el);
        const names = wanted.length ? wanted : [
          'display','color','backgroundColor','borderColor','fontSize','fontWeight',
          'gridRow','gridColumn','minHeight','width','height','opacity','borderRadius',
        ];
        const styles = {};
        for (const name of names) styles[name] = computed[name];
        return { found: true, selector: ${JSON.stringify(selector)}, styles };
      `);
    });
  },

  /**
   * The readability floor, measured on the live page: text below 12px, contrast failures, controls
   * under 24px, and form fields whose own text is unreadable on their own background.
   */
  async contrast(theme) {
    return withApp(async (app) => {
      if (theme === "dark" || theme === "light") {
        await app.evaluate(`
          const select = document.getElementById('themeSelect');
          if (select) { select.value = ${JSON.stringify(theme)}; select.dispatchEvent(new Event('change', { bubbles: true })); }
          return 'ok';
        `);
        await wait(500);
      }
      const results = {};
      for (const name of PAGES) {
        await app.evaluate(`document.querySelector('.nav-item[data-page="${name}"]').click(); return 'ok';`);
        await wait(600);
        const measured = await app.evaluate(MEASURE_SOURCE);
        results[name] = Object.fromEntries(
          Object.entries(measured).map(([key, list]) => [key, list.length]),
        );
      }
      const total = {};
      for (const page of Object.values(results)) {
        for (const [key, count] of Object.entries(page)) total[key] = (total[key] || 0) + count;
      }
      return { theme: await app.evaluate(`return document.documentElement.dataset.theme`), totals: total, perPage: results };
    });
  },

  /** The domain lists the renderer is holding. */
  async lists(which = "all") {
    return withApp(async (app) => {
      return app.evaluate(`
        const bridge = window.domBook;
        const wanted = ${JSON.stringify(which)};
        const result = {};
        if (wanted === 'all' || wanted === 'places') result.places = (await bridge.places.list()).data?.map((p) => p.name);
        if (wanted === 'all' || wanted === 'units') result.units = (await bridge.properties.list()).data?.map((p) => p.name);
        if (wanted === 'all' || wanted === 'reservations') result.reservations = (await bridge.reservations.list()).data?.map((r) => [r.guest_name, r.status, r.check_in_date, r.check_out_date].join(' | '));
        return result;
      `);
    });
  },

  /** Sync: what is queued, what is stuck, what the last attempt said. */
  async sync() {
    return withApp(async (app) => {
      return app.evaluate(`return (await window.domBook.sync.status()).data`);
    });
  },

  /** A PNG of the current screen. */
  async shot(file) {
    const target = file ? path.resolve(file) : path.join(ROOT, "artifacts", `screen-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return withApp(async (app) => {
      await app.screenshot(target);
      return { file: target, bytes: fs.statSync(target).size };
    });
  },

  /** Sign in with the development code echo. Signing in as a different account wipes local data. */
  async signin(email) {
    if (!email) fail("нужен email", "node scripts/inspect.mjs signin demo@rentkeeper.test");
    return withApp(async (app) => {
      await app.evaluate(`
        const form = document.getElementById('loginEmailForm');
        form.elements.loginEmail.value = ${JSON.stringify(email)};
        form.querySelector('button[type=submit]').click();
        return 'ok';
      `);
      await wait(3200);
      const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g, '') : '';`);
      if (!code) fail("код не пришёл", "приложение уже авторизовано, или /auth/send ограничил частоту");
      await app.evaluate(`
        const form = document.getElementById('loginCodeForm');
        form.elements.loginCode.value = ${JSON.stringify(code)};
        form.querySelector('button[type=submit]').click();
        return 'ok';
      `);
      await wait(4000);
      if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
        await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
        await wait(3000);
      }
      return app.evaluate(`
        return { signedIn: document.getElementById('loginScreen').classList.contains('is-hidden'),
          account: (document.querySelector('#cloudAccount strong') || {}).textContent || null };
      `);
    });
  },

  /** The tail of the app's own log — where a refused write explains itself. */
  async logs(lines = "40") {
    const file = "/tmp/e2e-app.log";
    const own = "/tmp/rentkeeper-app.log";
    const chosen = fs.existsSync(file) && fs.statSync(file).size > 0 ? file : own;
    if (!fs.existsSync(chosen)) fail("лога нет", `искал ${file} и ${own}`);
    const all = fs.readFileSync(chosen, "utf8").split("\n").filter(Boolean);
    return { file: chosen, lines: all.slice(-Number(lines)) };
  },
};

const [command, ...args] = process.argv.slice(2);
if (!command || command === "help" || command === "--help") {
  process.stdout.write(`inspect.mjs — механические вопросы к запущенному приложению

  status                     что подключено, кто вошёл, что на экране
  imports                    каждый модуль рендерера импортируется
  page <имя>                 перейти на страницу и вернуть её текст
  text <селектор>            текст элемента
  style <селектор> [свойства] вычисленные стили (не атрибут style)
  contrast [dark|light]      порог читаемости на живом экране
  lists [places|units|reservations|all]
  sync                       очередь и результат последней синхронизации
  shot [файл]                снимок экрана
  signin <email>             вход с dev-кодом
  logs [n]                   хвост лога приложения

Вывод — JSON. Страницы: ${PAGES.join(", ")}
`);
  process.exit(0);
}

if (!commands[command]) fail(`неизвестная команда «${command}»`, "node scripts/inspect.mjs help");
out(await commands[command](...args));
