const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The shell publishes a handful of handles on `window` for the end-to-end suites to drive the app
// through — a CDP `Runtime.evaluate` can reach nothing else. That list is a CONTRACT, and it is an
// easy one to break by tidying: the names look like leftovers, `no-undef` does not flag them in
// app.js (they are module-scope there), and nothing else in the repository refers to them.
//
// Removing one does not fail a build. It fails a suite, later, in a way that reads as a product
// fault — "the dialog never opens" — when the dialog is fine and its handle is gone.
const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "src", "renderer", "js", "app.js"), "utf8");

/** The names the shell lends to the test harness. */
function exportedToWindow() {
  const block = APP.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\);/);
  assert.ok(block, "не найден блок Object.assign(window, {...}) в app.js");
  return new Set(
    block[1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim().replace(/,$/, ""))
      .filter((line) => /^[A-Za-z_$][\w$]*$/.test(line)),
  );
}

test("ручки, которыми сьюты водят приложение, остаются на window", () => {
  // Named individually rather than inferred: this is the contract, and it should be edited
  // deliberately when a suite starts needing something new.
  const required = [
    "state", "PAGE_META", "refreshCore", "navigate", "activeProperties",
    "openReservationDialog", "openRentalDialog", "openPropertyDialog", "openPlaceDialog",
    "openDocumentsDialog", "openDocumentFile", "unwrap", "toast", "applyTheme",
  ];
  const exported = exportedToWindow();
  const missing = required.filter((name) => !exported.has(name));
  assert.deepEqual(missing, [], "эти ручки нужны сьютам, но их больше нет на window");
});

test("сьюты действительно пользуются только объявленными ручками", () => {
  // The other direction: a suite reaching for something nobody published would fail at runtime
  // with "x is not a function" — inside a template string, where the message is easy to misread.
  const exported = exportedToWindow();
  const suites = fs.readdirSync(path.join(ROOT, "scripts"))
    .filter((name) => name.startsWith("e2e-") && name.endsWith(".mjs"));
  assert.ok(suites.length >= 8, `сьютов найдено ${suites.length}`);

  // Only calls written as `window.<name>(` are unambiguous: a bare name inside an evaluated string
  // may be the page's own global, a local, or a variable the suite defined.
  const offenders = [];
  for (const suite of suites) {
    const source = fs.readFileSync(path.join(ROOT, "scripts", suite), "utf8");
    for (const match of source.matchAll(/window\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!exported.has(match[1]) && match[1] !== "domBook") {
        offenders.push(`${suite}: window.${match[1]}`);
      }
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
});
