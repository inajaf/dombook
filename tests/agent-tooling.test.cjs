const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The mechanical layer is a claim about what an agent can rely on: a command exists, it does what
// its name says, and it is there next month. These tests are what makes that true — a playbook that
// tells an agent to run a script somebody deleted is worse than no playbook, because it wastes the
// session before anyone notices.
const ROOT = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const playbookFiles = fs.readdirSync(path.join(ROOT, "playbooks")).filter((f) => f.endsWith(".json"));

test("у каждого плейбука есть имя, когда применять, шаги и критерий готовности", () => {
  assert.ok(playbookFiles.length >= 5, `плейбуков найдено ${playbookFiles.length}`);
  for (const file of playbookFiles) {
    const data = JSON.parse(read("playbooks", file));
    assert.equal(`${data.name}.json`, file, "имя плейбука должно совпадать с именем файла");
    assert.ok(data.when && data.when.length > 10, `${file}: не сказано, когда применять`);
    assert.ok(data.verification && data.verification.length > 20, `${file}: нет условия проверки`);
    assert.ok(Array.isArray(data.steps) && data.steps.length >= 3, `${file}: шагов меньше трёх`);
    for (const step of data.steps) {
      // Every step carries its evidence. A step without one is an instruction to feel finished.
      assert.ok(step.step && step.do && step.evidence, `${file}: шаг без доказательства — ${step.step}`);
    }
    assert.ok(Array.isArray(data.exit) && data.exit.length, `${file}: не сказано, что значит «готово»`);
  }
});

test("плейбук не отправляет агента к скрипту, которого нет", () => {
  // The failure this catches is silent: the agent runs the command, gets "no such file", and
  // improvises — which is the behaviour the playbook exists to replace.
  const referenced = new Set();
  for (const file of playbookFiles) {
    const text = read("playbooks", file);
    for (const match of text.matchAll(/scripts\/[a-z0-9-]+\.(sh|mjs)/g)) referenced.add(match[0]);
    for (const match of text.matchAll(/tests\/[a-z0-9-]+\.test\.cjs/g)) referenced.add(match[0]);
  }
  assert.ok(referenced.size >= 3, `плейбуки ссылаются всего на ${referenced.size} команд`);
  for (const target of referenced) {
    assert.ok(fs.existsSync(path.join(ROOT, target)), `плейбук ссылается на ${target}, которого нет`);
  }
});

test("роутер отказывается работать без условия проверки", () => {
  const router = path.join(ROOT, "scripts", "playbook.sh");
  const withGoal = spawnSync("bash", [router, "bugfix", "цель без проверки"], { cwd: ROOT, encoding: "utf8" });
  // Exit 3 is its own code, not 1: "you did not tell me how to know I am done" is a different
  // failure from "the work failed", and a caller can tell them apart.
  assert.equal(withGoal.status, 3, "без условия проверки роутер должен отказать кодом 3");
  assert.match(withGoal.stdout, /Условие проверки не задано/);

  const withBoth = spawnSync("bash", [router, "bugfix", "цель", "падающий тест проходит"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(withBoth.status, 0);
  assert.match(withBoth.stdout, /Проверка\.\*\* падающий тест проходит/);

  const unknown = spawnSync("bash", [router, "такого-нет", "ц", "п"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(unknown.status, 2);
});

test("список плейбуков показывает все, что есть на диске", () => {
  const listed = spawnSync("bash", [path.join(ROOT, "scripts", "playbook.sh"), "list"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(listed.status, 0);
  for (const file of playbookFiles) {
    assert.match(listed.stdout, new RegExp(`\\b${path.basename(file, ".json")}\\b`), `${file} не показан в списке`);
  }
});

test("CLI осмотра объявляет каждую команду, которая в нём есть", () => {
  // The help text IS the contract with the agent: a command that exists but is not listed is a
  // command nobody will use, and the hand-written probes come back.
  const source = read("scripts", "inspect.mjs");
  const help = spawnSync("node", [path.join(ROOT, "scripts", "inspect.mjs"), "help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(help.status, 0);
  const declared = [...source.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 8, `команд найдено ${declared.length}`);
  for (const name of declared) {
    assert.match(help.stdout, new RegExp(`\\b${name}\\b`), `${name} не описана в справке`);
  }
});

test("CLI осмотра отказывает на неизвестной команде, а не молчит", () => {
  const result = spawnSync("node", [path.join(ROOT, "scripts", "inspect.mjs"), "такой-команды-нет"], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /неизвестная команда/);
});

test("измерение читаемости существует в одном экземпляре", () => {
  // Two copies would eventually disagree about which surfaces count — the drift the fixtures exist
  // to prevent, one level up. The suite imports it; it does not carry its own.
  const suite = read("scripts", "e2e-interface.mjs");
  const cli = read("scripts", "inspect.mjs");
  assert.match(suite, /from "\.\/lib\/measure\.mjs"/, "сьют должен импортировать общее измерение");
  assert.match(cli, /from "\.\/lib\/measure\.mjs"/, "CLI должен импортировать общее измерение");
  assert.doesNotMatch(suite, /const MEASURE = `/);
  const measure = read("scripts", "lib", "measure.mjs");
  assert.match(measure, /export const MEASURE_SOURCE/);
});
