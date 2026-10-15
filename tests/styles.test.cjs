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
