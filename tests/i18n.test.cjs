// Every label the interface shows must exist in all three languages.
//
// The Russian source string IS the translation key (`window.i18n` looks the rendered text up in
// the locale's `messages` map). That has one sharp edge: a string with no entry does not fail,
// it silently stays Russian — so an Azerbaijani user meets "Работа" in the middle of an
// otherwise translated sidebar, and nothing anywhere reports it. Adding a label is therefore a
// two-file change, and this is the check that says so.
//
// Scope: the static markup. `src/renderer/app.js` builds a great deal of text at runtime from
// Russian literals (error messages, status labels, interpolation), and those are NOT covered
// here — they are asserted where they are produced, and the e2e branding suite asserts the
// rendered result in all three locales. Widening this file to app.js would mean guessing which
// Cyrillic literal is user-facing, and a guess is not a test.

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
