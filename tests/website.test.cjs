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
  assert.match(html, /Мобильной версии нет/, "мобильная версия не названа прямо");
  assert.match(html, /mobile-gate/, "нет экрана для телефона");
});

test("ссылки на скачивание ведут в релизы, а не в никуда", () => {
  const downloads = [...html.matchAll(/class="download__card[^"]*"\s+href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(downloads.length, 2, `кнопок скачивания найдено ${downloads.length}`);
  for (const href of downloads) {
    assert.match(href, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases/,
      `кнопка скачивания ведёт не в релизы: ${href}`);
  }
});

/**
 * The span of an at-rule's block: from the `{` after its prelude to the matching `}`.
 *
 * Brace counting, not a regular expression, because the question is "is this rule INSIDE that
 * block" — and a regex answers "does this text appear", which is how the first version of this
 * test passed on a page that rendered blank.
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
      "`.reveal` скрыт вне защиты от выключенного скрипта — страница останется пустой");
  }

  assert.match(css, /prefers-reduced-motion/, "не учтён prefers-reduced-motion");
  assert.match(js, /prefers-reduced-motion/, "скрипт не проверяет prefers-reduced-motion");
  assert.match(js, /showAll\(\)/, "нет пути, на котором содержимое показывается без наблюдателя");
  // ...and the net for a script that runs but whose observer never fires.
  assert.match(js, /setTimeout\(/, "нет страховки на случай, когда наблюдатель не сработал");
});

test("страница работает и без веб-сервера", () => {
  // A module script is fetched with CORS, so from a `file://` origin the browser refuses it and the
  // page is blank — the exact failure this site shipped with, found by rendering it. A classic
  // script loads either way, and nothing on this page needs imports.
  const script = html.match(/<script[^>]*src="\.\/main\.js"[^>]*>/);
  assert.ok(script, "нет подключения main.js");
  assert.doesNotMatch(script[0], /type="module"/,
    "main.js подключён модулем: со скачанного файла он не загрузится, и страница будет пустой");
});
