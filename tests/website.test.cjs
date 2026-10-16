const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The product page is a static file, so nothing in it is checked by loading the application. What
// CAN be checked is the part that goes stale silently: a version number nobody bumped, a download
// link that points nowhere, an asset that was renamed. Each of those is a broken promise on the one
// page a visitor sees before they have any reason to trust the product.
const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "website");
const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("версия на сайте совпадает с версией продукта", () => {
  const shown = html.match(/data-version>([^<]+)</);
  assert.ok(shown, "на странице нет элемента data-version");
  assert.equal(shown[1].trim(), pkg.version,
    "версия на сайте разошлась с package.json — релиз выпустят, а страница будет обещать другое");
});

test("каждый файл, на который ссылается страница, существует", () => {
  const missing = [];
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
    const target = match[1].split("?")[0];
    if (!fs.existsSync(path.join(SITE, target))) missing.push(target);
  }
  assert.deepEqual(missing, [], "страница ссылается на файлы, которых нет");
});

test("обещанные платформы названы, а мобильная — нет", () => {
  // What the page promises is the whole point of it. macOS and Windows are offered; a phone is
  // not, because there is no phone build, and a download button that leads nowhere is worse than
  // an honest sentence.
  assert.match(html, /macOS/, "не сказано про macOS");
  assert.match(html, /Windows/, "не сказано про Windows");
  assert.match(html, /No phone version/, "отсутствие мобильной версии не сказано прямо");
  assert.match(html, /class="gate"/, "нет экрана для телефона");
});

test("страница не обещает сборку, которой нет", () => {
  // The download buttons led to a releases page with NOTHING on it: the v0.2.0 tag exists only on
  // a local machine, and `gh release list` was empty. A product page whose primary button is a
  // dead end is the most expensive kind of wrong, so the page has to say the state out loud.
  assert.match(html, /No build is published yet/, "страница умалчивает, что сборки не опубликованы");
  assert.match(html, /build it from source|build from source/i, "не сказано, что делать вместо этого");
});

test("каждый текст на странице переведён на три языка", () => {
  // A missing key is not a blank, it is English: the page falls back, which is right, and silent,
  // which is not. The application's own markup has the same guard for the same reason.
  const dict = fs.readFileSync(path.join(SITE, "i18n.js"), "utf8");
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 50, `ключей перевода найдено ${keys.length}`);
  const [ru, az] = dict.split("var AZ");
  for (const [name, part] of [["ru", ru], ["az", az]]) {
    const defined = new Set([...part.matchAll(/"([A-Za-z0-9.]+)"\s*:/g)].map((m) => m[1]));
    const missing = [...new Set(keys)].filter((key) => !defined.has(key));
    assert.deepEqual(missing, [], `${name}: нет перевода для ${missing.join(", ")}`);
  }
  // English is not in the dictionary on purpose: it is snapshotted from the markup, so the two
  // cannot drift into disagreeing about what the page says.
  assert.doesNotMatch(ru, /^\s*"en"/m, "английский должен оставаться в разметке");
});

test("в текстах нет штампов машинного письма", () => {
  // The page is read by people deciding whether to trust the product with their bookings. Long
  // dashes and the rest of the register that gives a text away cost more here than anywhere.
  const i18n = fs.readFileSync(path.join(SITE, "i18n.js"), "utf8");
  const tells = [
    ["длинное тире", /\u2014/],
    ["дефис вместо тире", /\s-\s/],
    ["not just X but Y", /not just .{3,40} but /i],
  ];
  for (const [label, pattern] of tells) {
    assert.doesNotMatch(html, pattern, `в разметке найден штамп: ${label}`);
    assert.doesNotMatch(i18n, pattern, `в переводах найден штамп: ${label}`);
  }
  for (const word of ["delve", "showcase", "testament to", "vibrant", "seamless", "leverage", "utilize"]) {
    assert.doesNotMatch(html, new RegExp(word, "i"), `в разметке найден штамп: ${word}`);
  }
});

/**
 * The span of an at-rule's block: from the `{` after its prelude to the matching `}`.
 *
 * Brace counting, not a regular expression, because the question is "is this rule INSIDE that
 * block" and a regex answers "does this text appear", which is how an earlier version of this test
 * passed on a page that rendered blank.
 */
function blockSpan(css, prelude) {
  const at = css.indexOf(prelude);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return [open, i];
    }
  }
  return null;
}

test("движение не является условием видимости содержимого", () => {
  // The first version of this test looked for the PRESENCE of a fallback and passed while the page
  // rendered blank: `.reveal { opacity: 0 }` was unconditional, an observer that never fired left
  // every section invisible, and the assertion could not tell the difference. A test that checks a
  // token instead of a property reports a pass on a blank page.
  const css = fs.readFileSync(path.join(SITE, "styles.css"), "utf8");
  const js = fs.readFileSync(path.join(SITE, "main.js"), "utf8");

  const hiding = [...css.matchAll(/\.reveal\s*\{[^}]*opacity:\s*0/g)].map((m) => m.index);
  assert.ok(hiding.length > 0, "нет правила, которое готовит появление секций");

  const guard = blockSpan(css, "@media (scripting: enabled)");
  assert.ok(guard, "скрытие не ограничено включённым скриптом: нет @media (scripting: enabled)");
  for (const index of hiding) {
    assert.ok(index > guard[0] && index < guard[1],
      "`.reveal` скрыт вне защиты от выключенного скрипта: страница останется пустой");
  }

  assert.match(css, /prefers-reduced-motion/, "не учтён prefers-reduced-motion");
  assert.match(js, /prefers-reduced-motion/, "скрипт не проверяет prefers-reduced-motion");
  assert.match(js, /showAll\(\)/, "нет пути, на котором содержимое показывается без наблюдателя");
  assert.match(js, /setTimeout\(/, "нет страховки на случай, когда наблюдатель не сработал");
});

test("заголовок остаётся видимым без анимации", () => {
  // The hero title is masked and animated up from below. If the resting state were the hidden one,
  // the first thing a visitor reads would be missing for anyone whose animation never runs.
  const css = fs.readFileSync(path.join(SITE, "styles.css"), "utf8");
  const reduced = blockSpan(css, "@media (prefers-reduced-motion: reduce)");
  assert.ok(reduced, "нет блока prefers-reduced-motion");
  const block = css.slice(reduced[0], reduced[1]);
  assert.match(block, /\.hero__title\s+\.line__in\s*\{[^}]*transform:\s*none/,
    "при отключённой анимации строки заголовка остаются сдвинутыми за край");
});
