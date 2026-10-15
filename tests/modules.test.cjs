const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The renderer is a module graph with no bundler, so a missing import is not a build error — it is
// a ReferenceError at the moment that line runs, which for a toast means "the message that tells
// you something failed is itself what fails". Two of them shipped in the split: `$` in toast.js,
// and `$$` in the entry, and neither showed up until a screen called one.
const RENDERER = path.join(__dirname, "..", "src", "renderer", "js");

/** Strip comments, strings and template literals so a mention in prose is not a call. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

const modules = fs.readdirSync(RENDERER).filter((name) => name.endsWith(".js"));

test("каждый модуль импортирует то, что вызывает", () => {
  for (const name of modules) {
    const source = fs.readFileSync(path.join(RENDERER, name), "utf8");
    const stripped = code(source);
    const imported = new Set();
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const part of m[1].split(",")) {
        const imported_ = part.trim().split(/\s+as\s+/).pop();
        if (imported_) imported.add(imported_);
      }
    }
    for (const helper of ["$", "$$"]) {
      // `$$(` must not be read as `$(`: match the call, not a substring of it.
      const calls = helper === "$"
        ? /(?<![\w.$])\$(?!\$)\s*\(/.test(stripped)
        : /(?<![\w.$])\$\$\s*\(/.test(stripped);
      if (!calls) continue;
      assert.ok(imported.has(helper),
        `${name} вызывает ${helper}() но не импортирует его — модуль упадёт в тот момент, когда эта строка выполнится`);
    }
  }
});

test("точка входа грузится как модуль", () => {
  // The entry must be a module: the other files use `import`, which a classic script cannot.
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /<script type="module" src="\.\/js\/app\.js/,
    "index.html должен грузить js/app.js как модуль");
  // ...and the theme bootstrap must NOT be a module: a module is deferred, so the window would
  // paint light and then turn dark.
  assert.match(html, /<script src="\.\/js\/theme-boot\.js/,
    "theme-boot.js должен остаться классическим скриптом, иначе окно мигнёт светлым");
});
