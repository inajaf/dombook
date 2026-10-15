const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The renderer is a module graph with NO bundler, so nothing links it ahead of time. A file that
// calls a sibling's function without importing it is a ReferenceError at the moment that line
// runs — and only then.
//
// Two of those shipped during the split, and both were found by USING the app rather than by a
// test: `toast.js` called `$()` without importing it, so the message that reports a failure was
// itself the failure, and `views/properties.js` used `api` without importing it, so saving a unit
// silently did nothing.
//
// The check is deliberately NARROW, and that is the point: it compares each module against the
// names OTHER modules actually export. An identifier that no module exports is somebody else's
// problem (a parameter, a platform global, a local); one that a sibling exports and this file did
// not import is unambiguously this bug. A general "unresolved identifier" linter written with
// regular expressions reports destructuring targets and parameters as errors, and a test nobody
// trusts is worse than no test.
const RENDERER = path.join(__dirname, "..", "src", "renderer", "js");

function moduleFiles() {
  const files = fs.readdirSync(RENDERER)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(RENDERER, name));
  const views = path.join(RENDERER, "views");
  if (fs.existsSync(views)) {
    files.push(...fs.readdirSync(views).filter((name) => name.endsWith(".js")).map((name) => path.join(views, name)));
  }
  return files;
}

/** What a module lends out. Only `export`ed names can be borrowed, so only they can be forgotten. */
function exportedNames(source) {
  const names = new Set();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+const\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+let\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+class\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

/** Names the module declares for itself, exported or not: a local shadows a sibling's export. */
function localNames(source) {
  const names = new Set();
  for (const pattern of [
    /(?:^|[^\w.$])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|[^\w.$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|[^\w.$])class\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

function importedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const piece of match[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(match[1]);
  return names;
}

/** Comments, strings and template literals mention names without using them. */
function stripNonCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

const files = moduleFiles();
const sources = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));

test("модуль не пользуется экспортом соседа, не импортировав его", () => {
  const problems = [];
  for (const [file, source] of sources) {
    const code = stripNonCode(source);
    const imported = importedNames(source);
    const own = new Set([...exportedNames(source), ...localNames(source)]);
    for (const [other, otherSource] of sources) {
      if (other === file) continue;
      for (const name of exportedNames(otherSource)) {
        if (own.has(name) || imported.has(name)) continue;
        // A bare use: not a property access, not a property key, not part of a longer word.
        const used = new RegExp(`(?:^|[^.\\w$'"\`])${name.replace(/\$/g, "\\$")}(?![\\w$])\\s*[.(\`]`, "m");
        if (used.test(code)) {
          problems.push(`${path.relative(process.cwd(), file)} использует ${name}() из ${path.basename(other)}, но не импортирует его`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("каждый импорт указывает на то, что модуль экспортирует", () => {
  // A missing EXPORT is worse than a missing import: the browser refuses to link the graph and the
  // entry module never runs, so the window is blank rather than one screen short. It is also the
  // easiest mistake to make while moving code, because the name exists — one file over.
  const exports = new Map();
  for (const file of moduleFiles()) exports.set(file, exportedNames(sources.get(file)));

  const problems = [];
  for (const file of moduleFiles()) {
    for (const match of sources.get(file).matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
      const target = path.resolve(path.dirname(file), match[2]);
      const wanted = match[1].split(",").map((piece) => piece.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const name of wanted) {
        if (!exports.get(target)?.has(name)) {
          problems.push(`${path.relative(process.cwd(), file)} импортирует ${name} из ${path.basename(target)}, где его нет`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("каждый модуль грузится как модуль, а bootstrap темы — нет", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /<script type="module" src="\.\/js\/app\.js/,
    "index.html должен грузить js/app.js как модуль");
  assert.match(html, /<script src="\.\/js\/theme-boot\.js/,
    "theme-boot.js должен остаться классическим скриптом, иначе окно мигнёт светлым");
});
