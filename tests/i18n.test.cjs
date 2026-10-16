// Every label the interface shows must exist in all three languages.
//
// The Russian source string IS the translation key (`window.i18n` looks the rendered text up in
// the locale's `messages` map). That has one sharp edge: a string with no entry does not fail,
// it silently stays Russian — so an Azerbaijani user meets "Работа" in the middle of an
// otherwise translated sidebar, and nothing anywhere reports it. Adding a label is therefore a
// two-file change, and this is the check that says so.
//
// Scope: the static markup, plus the phrases a view builds through `translate()` from
// `js/i18n-text.js`. What is still NOT covered is a bare Russian literal in the renderer (error
// messages, interpolation): guessing which Cyrillic string is user-facing would be a guess, not a
// test. The rule for a view is therefore to build its text with `translate()`, which this file can
// then check, and the e2e branding suite asserts the rendered result in all three locales.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const LOCALES = ["ru", "az", "en"];

function loadLocale(code) {
  const file = path.join(ROOT, "src/renderer/i18n", `${code}.js`);
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  const packs = context.window.RentKeeperLocales || {};
  const pack = Object.values(packs)[0];
  assert.ok(pack, `${code}.js did not register a locale`);
  return pack;
}

const CYRILLIC = /[А-Яа-яЁё]/;

/** Text nodes and the attributes `translateDom` rewrites, from the static markup. */
function translatableStrings() {
  const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg class="svg-sprite"[\s\S]*?<\/svg>/g, "");
  const found = new Set();
  for (const [, text] of html.matchAll(/>([^<>]+)</g)) {
    const value = text.trim();
    if (value && CYRILLIC.test(value)) found.add(value);
  }
  for (const [, value] of html.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)) {
    if (value.trim() && CYRILLIC.test(value)) found.add(value.trim());
  }
  return [...found];
}

const locales = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
const strings = translatableStrings();

/**
 * Strings that are deliberately identical in every language.
 *
 * A language picker shows each language in its own script — translating "Русский" into
 * Azerbaijani would make the list harder to scan for the one person it is for — and the address
 * in the example placeholder is a real place in the region the product sells in, not prose.
 * Kept short on purpose: the list is where a missing translation goes to hide, so it is asserted
 * to stay small.
 */
const SAME_IN_EVERY_LANGUAGE = new Set(["Русский", "Габала, Нохургышлаг"]);

test("the markup actually contains strings to check", () => {
  // A silent extraction failure would make every check below pass on an empty list.
  assert.ok(strings.length > 40, `only ${strings.length} strings extracted from index.html`);
  assert.ok(SAME_IN_EVERY_LANGUAGE.size <= 3, "the untranslated allowlist has grown — justify each entry");
  for (const value of SAME_IN_EVERY_LANGUAGE) {
    assert.ok(strings.includes(value), `"${value}" is allowlisted but no longer in the markup`);
  }
});

for (const code of ["az", "en"]) {
  test(`${code} translates every label in the markup`, () => {
    const missing = strings.filter((value) => !(value in locales[code].messages) && !SAME_IN_EVERY_LANGUAGE.has(value));
    assert.deepEqual(missing, [], `${code}.js is missing: ${missing.join(" | ")}`);
  });

  test(`${code} does not leave a translation in Russian`, () => {
    // A key that is copied through unchanged is indistinguishable from a missing one on screen.
    // Proper nouns are exempt: "RentKeeper" is the same word in every language, and it has no
    // Cyrillic to begin with.
    const untranslated = strings.filter((value) => {
      const translated = locales[code].messages[value];
      return typeof translated === "string" && CYRILLIC.test(translated);
    });
    assert.deepEqual(untranslated, [], `${code}.js still shows Russian for: ${untranslated.join(" | ")}`);
  });
}

test("the navigation is grouped by name, and every group is translated", () => {
  // The sidebar's two section labels are the whole point of the regrouping, and they are the
  // kind of string that gets added to the markup and forgotten in the dictionaries.
  const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
  const groups = [...html.matchAll(/class="nav-group-title"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  assert.deepEqual(groups, ["Работа", "Система"]);
  for (const code of ["az", "en"]) {
    for (const group of groups) {
      assert.ok(locales[code].messages[group], `${code}.js is missing the group label "${group}"`);
    }
  }
});

test("фразы, которые представления собирают в рантайме, переведены", async () => {
  // The markup suite above cannot see a string a VIEW builds: it is not in index.html, so a missing
  // entry does not fail, the phrase simply stays Russian. Two shipped that way in the calendar and
  // an English screenshot is what found them: "17 из 84 ночей" and "свободно 14 ночей с Oct 29".
  //
  // The check reads every `translate("...")` call in the renderer and asserts the dictionaries
  // carry it. Russian needs no entry: it is the source language and the key comes back as is.
  const viewsDir = path.join(__dirname, "..", "src", "renderer", "js");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(viewsDir);

  const used = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\btranslate\(\s*"([^"]+)"/g)) used.add(match[1]);
  }
  assert.ok(used.size > 0, "не найдено ни одного вызова translate() со строкой");

  for (const locale of ["en", "az"]) {
    const dictionary = locales[locale].messages;
    const missing = [...used].filter((key) => !(key in dictionary));
    assert.deepEqual(missing, [], `${locale}: нет перевода для ${missing.join(" | ")}`);
  }
});
