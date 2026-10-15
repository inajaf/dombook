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
const SCRIPTS = path.join(__dirname, "..", "scripts");

/**
 * Every ES module in the project, not only the renderer's.
 *
 * The renderer is the graph this test was written for — it has no bundler, so nothing links it
 * ahead of time and a missing import is a `ReferenceError` at the moment that line runs. The
 * harness under `scripts/` is the same kind of graph for the same reason, and it was NOT covered:
 * `scripts/e2e-lib.mjs` came to use `userDataDir` from a sibling without importing it and this
 * suite stayed green. The failure it would have produced is the one that costs the most here —
 * a profile that is never deleted, so every suite inherits the previous run's rows and the
 * failures look like product bugs.
 */
function moduleFiles() {
  const files = [];
  const add = (dir, filter = () => true) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue;
      if (filter(name)) files.push(path.join(dir, name));
    }
  };
  add(RENDERER);
  add(path.join(RENDERER, "views"));
  add(SCRIPTS);
  add(path.join(SCRIPTS, "lib"));
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

/**
 * Replace comments and string literals with BLANKS OF THE SAME LENGTH.
 *
 * This was five regular expressions, and they were wrong in a way that mattered: a template literal
 * containing `${...}` closes at the FIRST backtick the regex finds, not at the real one, so
 * everything after a mis-paired backtick was DELETED from the text under analysis. On
 * `scripts/e2e-lib.mjs` — a file full of template literals holding CDP blocks — the stripper
 * reduced 14628 bytes to 5054, and every check below ran against the remaining third and reported
 * a pass. `userDataDir`, used without being imported a few lines past the damage, was never seen.
 *
 * That is the failure this project already has a name for: a measurement that silently skips what
 * it cannot parse is worse than no measurement, because it reports a pass. So the replacement is a
 * scanner rather than a pattern, and it is LENGTH-PRESERVING on purpose — the test below asserts
 * that for every file, so a stripper that eats code fails loudly instead of quietly.
 */
function stripNonCode(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const stop = text.indexOf("\n", i);
      const end = stop === -1 ? n : stop;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const stop = text.indexOf("*/", i + 2);
      const end = stop === -1 ? n : stop + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      const end = Math.min(j + 1, n);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "`") {
      // A template closes at its OWN backtick, not at the first one inside an interpolation, and
      // `${` may nest. Tracking that depth is the whole difference between this and the regex.
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "$" && text[j + 1] === "{") { depth += 1; j += 2; continue; }
        if (text[j] === "}" && depth > 0) { depth -= 1; j += 1; continue; }
        if (text[j] === "`" && depth === 0) { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const files = moduleFiles();
const sources = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));

test("разбор кода не съедает сам код", () => {
  // The stricter check below is worth only what it can SEE. A stripper that removes a third of a
  // file makes every check after it vacuous while still reporting a pass — which is what happened
  // here — so the property is asserted rather than assumed.
  const shrunk = [];
  for (const [file, source] of sources) {
    const stripped = stripNonCode(source);
    if (stripped.length !== source.length) {
      shrunk.push(`${path.relative(process.cwd(), file)}: ${source.length} → ${stripped.length}`);
    }
  }
  assert.deepEqual(shrunk, [], "стриппер обязан сохранять длину: он затирает код пробелами, а не удаляет его");
});

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
      // Only RELATIVE imports are part of this graph. A Node builtin (`node:fs`) has no file to
      // resolve to and no exports to compare against, and treating one as a sibling produced a
      // page of confident nonsense the moment this suite was widened to cover scripts/.
      if (!match[2].startsWith(".")) continue;
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
