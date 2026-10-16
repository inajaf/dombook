const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The palette is two levels: semantic roles in :root and in [data-theme="dark"], and NO colour
// anywhere else. That is the whole reason a dark theme is possible here — a rule that names a
// colour is a rule that was not converted, and it shows up as a light patch on a dark page.
//
// The conversion that introduced this missed `background: white` on every form field, because it
// looked for hex literals and a colour KEYWORD is not one. In the dark theme that is near-white
// text on a white field: the value is there and cannot be read. The e2e suite measures it now, and
// this catches it in a second rather than in a browser.
const STYLES = path.join(__dirname, "..", "src", "renderer", "styles.css");

const SHELL = path.join(__dirname, "..", "src", "renderer", "js", "app.js");

const COLOUR_KEYWORDS = ["white", "black", "silver", "gray", "grey", "maroon", "navy", "teal", "olive", "lime", "aqua", "fuchsia"];

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The two token blocks, which are the ONLY places a colour may be named. */
function splitTokens(css) {
  const rootStart = css.indexOf(":root {");
  const rootEnd = css.indexOf("\n}", rootStart) + 2;
  const darkStart = css.indexOf('[data-theme="dark"] {');
  const darkEnd = css.indexOf("\n}", darkStart) + 2;
  return {
    tokens: css.slice(rootStart, rootEnd) + css.slice(darkStart, darkEnd),
    rules: css.slice(0, rootStart) + css.slice(rootEnd, darkStart) + css.slice(darkEnd),
  };
}

test("цвета называются только в блоках токенов", () => {
  const css = stripComments(fs.readFileSync(STYLES, "utf8"));
  const { rules } = splitTokens(css);

  const problems = [];
  rules.split("\n").forEach((line, index) => {
    const hex = line.match(/#[0-9a-fA-F]{3,8}\b/g);
    // `url("data:image/svg+xml,…%2346564d…")` is an encoded colour inside an asset, and the
    // chevron has to be drawn with a literal — it is not a themed surface.
    const inDataUri = /data:image\/svg/.test(line);
    if (hex && !inDataUri) problems.push(`строка ${index + 1}: ${hex.join(", ")} — ${line.trim().slice(0, 80)}`);
    for (const keyword of COLOUR_KEYWORDS) {
      // `white-space`, `blacklist` and friend are not colours.
      const pattern = new RegExp(`(?<![\\w-])${keyword}(?![\\w-])`, "i");
      if (pattern.test(line) && /(background|color|border|outline|fill|stroke|shadow)/i.test(line)) {
        problems.push(`строка ${index + 1}: «${keyword}» — ${line.trim().slice(0, 80)}`);
      }
    }
  });
  assert.deepEqual(problems, [],
    "правило называет цвет напрямую — в тёмной теме это светлое пятно на тёмной странице");
});

test("каждая роль определена в обеих темах", () => {
  const css = stripComments(fs.readFileSync(STYLES, "utf8"));
  const roles = (block) => new Set([...block.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]));
  const rootStart = css.indexOf(":root {");
  const rootEnd = css.indexOf("\n}", rootStart);
  const darkStart = css.indexOf('[data-theme="dark"] {');
  const darkEnd = css.indexOf("\n}", darkStart);
  const light = roles(css.slice(rootStart, rootEnd));
  const dark = roles(css.slice(darkStart, darkEnd));

  // Sizes and motion are theme-independent: only the colours have to exist twice.
  const thematic = (name) => !/^(text-|motion-|ease-|radius|sidebar-width|shadow)/.test(name);
  const missing = [...light].filter((name) => thematic(name) && !dark.has(name) && !["color-scheme"].includes(name));
  assert.deepEqual(missing, [],
    "роль определена для светлой темы и не переопределена для тёмной — она останется светлой на тёмной странице");
});

// THE OTHER HALF OF `animation-fill-mode: both`.
//
// A keyframe set that STARTS at `opacity: 0` and is applied with a backwards fill holds the element
// invisible until the animation runs, and a window that is occluded or throttled never advances the
// frame clock, so it never runs: the login screen, a page, a table of rows stays blank with nothing
// on screen to explain it. `settleEntranceMotion` (src/renderer/js/app.js) takes the motion away
// once it has had its time, which is what puts the element back in its resting state — and it can
// only do that while two things hold: the animation ENDS VISIBLE and it ends AT ALL. An entrance
// whose last keyframe hides the element, or one that iterates forever, is content no pass can give
// back, and it fails in exactly the way this mechanism exists to prevent.

/** The body of every `@keyframes` block in the sheet, by animation name. */
function keyframeBodies(css) {
  const bodies = new Map();
  for (const opener of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const start = opener.index + opener[0].length;
    let depth = 1;
    let end = start;
    while (depth > 0 && end < css.length) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") depth -= 1;
      end += 1;
    }
    bodies.set(opener[1], css.slice(start, end - 1));
  }
  return bodies;
}

/** `null` when the value is absent or is not a plain number — a `var()` is not ours to judge. */
function opacityOf(declarations) {
  const found = declarations.split(";").map((part) => part.trim()).find((part) => /^opacity\s*:/.test(part));
  if (!found) return null;
  const value = Number.parseFloat(found.slice(found.indexOf(":") + 1));
  return Number.isFinite(value) ? value : null;
}

/** Declarations under the keyframe stops a body labels `from, 0%` (or `to, 100%`) — the two ends. */
function stopDeclarations(body, stops) {
  const found = [];
  for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[1].split(",").some((stop) => stops.test(stop.trim()))) found.push(rule[2]);
  }
  return found.join(";");
}

const START_STOP = /^(from|0%)$/;
const END_STOP = /^(to|100%)$/;

/** Values of one longhand property in a rule body, comma-separated ones included. */
function longhandValues(body, property) {
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`));
  return match ? match[1].split(",").map((value) => value.trim()) : [];
}

/**
 * Every place the sheet holds an element back with a backwards fill: a rule whose animation names
 * a keyframe set that starts hidden — the entrance shape — and whose fill mode keeps that from-state
 * applied for as long as the animation has not run.
 *
 * Both spellings are read, the `animation` shorthand and the longhands, because a check that only
 * understood one of them would stop seeing a new entrance the moment somebody wrote the other, and
 * a guard nobody can trust is worse than none.
 */
function entranceAnimations(css, keyframes) {
  const found = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = rule[2];
    const shorthand = body.match(/(?:^|;)\s*animation\s*:\s*([^;]+)/);
    const value = shorthand ? shorthand[1] : longhandValues(body, "animation-name").join(",");
    const names = value.trim().split(/[\s,]+/).filter((token) => keyframes.has(token));
    if (!names.length) continue;
    const fill = shorthand ? shorthand[1] : longhandValues(body, "animation-fill-mode").join(",");
    if (!/(?:^|[\s,])(both|backwards)(?=$|[\s,])/.test(fill)) continue;
    const iterations = shorthand ? shorthand[1] : longhandValues(body, "animation-iteration-count").join(",");
    for (const name of names) {
      const keyframesBody = keyframes.get(name);
      if (opacityOf(stopDeclarations(keyframesBody, START_STOP)) !== 0) continue;
      found.push({
        selector: rule[1].trim(),
        name,
        infinite: /(?:^|[\s,])(infinite)(?=$|[\s,])/.test(iterations),
        endsHidden: opacityOf(stopDeclarations(keyframesBody, END_STOP)) === 0,
      });
    }
  }
  return found;
}

test("анимация входа заканчивается видимой и конечной", () => {
  const css = stripComments(fs.readFileSync(STYLES, "utf8"));
  const keyframes = keyframeBodies(css);
  const entrances = entranceAnimations(css, keyframes);
  assert.ok(entrances.length > 0,
    "в листе не нашлось ни одной анимации входа — либо их правда больше нет, либо проверка перестала видеть лист");

  const problems = [];
  for (const entrance of entrances) {
    if (entrance.endsHidden) {
      problems.push(`${entrance.selector}: ${entrance.name} — последний кадр скрывает элемент`);
    }
    if (entrance.infinite) {
      problems.push(`${entrance.selector}: ${entrance.name} — не заканчивается никогда`);
    }
  }
  assert.deepEqual(problems, [],
    "анимация входа оставит содержимое невидимым: вернуть его к покою можно только видимым концом конечной анимации");
});

test("проход, возвращающий покой, установлен при запуске", () => {
  const shell = fs.readFileSync(SHELL, "utf8");
  // The rule above is a promise the SHELL keeps: the sheet is only safe because the motion is taken
  // away once it has had its time. Delete that and the check above keeps passing while the blank
  // screen comes back. There is no DOM in this suite, so the wiring is read from the source.
  assert.match(shell, /document\.getAnimations\(\)/,
    "оболочка не перебирает анимации страницы — анимация входа останется в невидимом первом кадре");
  assert.match(shell, /animation\.(finish|cancel)\(\)/,
    "оболочка не снимает анимацию — элемент останется в её первом кадре");
  assert.match(shell, /MutationObserver/,
    "новые анимации появляются и после запуска: без наблюдателя проход увидит только стартовые");
  assert.match(shell, /^\s*watchEntranceMotion\(\);/m,
    "проход написан, но не установлен при запуске — до первого прохода анимация успеет остаться в первом кадре");
});
