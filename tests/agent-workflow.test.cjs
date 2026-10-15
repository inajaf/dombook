const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

// The rules an agent works under are only rules if the repository enforces them. A convention in a
// document is something a tired agent forgets at the end of a long session — which is exactly when
// it commits to main, or merges its own work.
//
// These tests run the guards themselves, in a throwaway repository, so the guards cannot rot into
// decoration.
const ROOT = path.join(__dirname, "..");
const HOOK = path.join(ROOT, ".githooks", "pre-commit");
const MERGE = path.join(ROOT, "scripts", "merge-verified.sh");

/** A throwaway repo with the real hook installed, so `git` runs it for us. */
function scratchRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rentkeeper-hook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "file.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  // Installed after the repository exists, in that order, because the hook refuses a commit on
  // main — including the fixture's own first one.
  fs.mkdirSync(path.join(dir, ".githooks"), { recursive: true });
  fs.copyFileSync(HOOK, path.join(dir, ".githooks", "pre-commit"));
  fs.chmodSync(path.join(dir, ".githooks", "pre-commit"), 0o755);
  git("config", "core.hooksPath", ".githooks");
  return { dir, git };
}

test("хук не даёт коммитить в main", (t) => {
  const { dir, git } = scratchRepo(t);
  fs.writeFileSync(path.join(dir, "file.txt"), "two\n");
  git("add", ".");

  const blocked = spawnSync("git", ["commit", "-m", "напрямую в main"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(blocked.status, 0, "коммит в main должен быть отклонён");
  assert.match(blocked.stderr, /коммит в main запрещён/);
  // The message has to say what to do instead, or the next thing an agent does is look it up.
  assert.match(blocked.stderr, /git switch -c/);
  assert.match(blocked.stderr, /RENTKEEPER_ALLOW_MAIN_COMMIT/);

  // ...and the work is still there, staged and uncommitted: a refused commit must not lose it.
  assert.match(git("status", "--short"), /file\.txt/);
});

test("хук пропускает ветку, detached HEAD и осознанное исключение", (t) => {
  const { dir, git } = scratchRepo(t);
  const write = (text) => { fs.writeFileSync(path.join(dir, "file.txt"), text); git("add", "."); };

  git("switch", "-q", "-c", "feature/x");
  write("branch\n");
  assert.equal(spawnSync("git", ["commit", "-m", "в ветке"], { cwd: dir }).status, 0, "в ветке коммит разрешён");

  // Detached HEAD is how a verifier checks a commit out; it is not somebody working on main.
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  git("checkout", "-q", sha);
  write("detached\n");
  assert.equal(spawnSync("git", ["commit", "-m", "detached"], { cwd: dir }).status, 0, "detached HEAD не блокируется");

  git("switch", "-q", "main");
  write("override\n");
  assert.equal(
    spawnSync("git", ["commit", "-m", "исключение"], { cwd: dir, env: { ...process.env, RENTKEEPER_ALLOW_MAIN_COMMIT: "1" } }).status,
    0,
    "осознанное исключение должно работать",
  );
});

/** The merge gate reads a verdict file and a PR head; `gh` is the only thing that needs faking. */
function runMergeGate(t, { pr = "7", sha, verdict, remoteSha = null, branch = "feature/x" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rentkeeper-merge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  fs.copyFileSync(MERGE, path.join(dir, "scripts", "merge-verified.sh"));
  fs.chmodSync(path.join(dir, "scripts", "merge-verified.sh"), 0o755);
  if (verdict) {
    fs.writeFileSync(path.join(dir, "artifacts", `verdict-${sha.slice(0, 7)}.json`), JSON.stringify(verdict));
  }
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo "${sha} ${branch}"; exit 0; fi
echo "gh $@" >> "${dir}/gh-calls.txt"
exit 0
`);
  // The gate asks the REMOTE where the branch is, because GitHub's answer can lag a push — the
  // case below is not hypothetical: it merged a pull request on a verdict for the previous commit.
  fs.writeFileSync(path.join(bin, "git"), `#!/usr/bin/env bash
if [ "$1" = "ls-remote" ]; then echo "${remoteSha ?? sha}	refs/heads/${branch}"; exit 0; fi
exec /usr/bin/git "$@"
`);
  fs.chmodSync(path.join(bin, "gh"), 0o755);
  fs.chmodSync(path.join(bin, "git"), 0o755);
  const result = spawnSync("bash", [path.join(dir, "scripts", "merge-verified.sh"), pr], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { ...result, calls: fs.existsSync(path.join(dir, "gh-calls.txt")) ? fs.readFileSync(path.join(dir, "gh-calls.txt"), "utf8") : "" };
}

test("слияние без вердикта не проходит", (t) => {
  const result = runMergeGate(t, { sha: "a".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /нет вердикта/);
  // The refusal must name the command that produces one, or the gate is a wall rather than a door.
  assert.match(result.stderr, /scripts\/verify-branch\.sh/);
  assert.equal(result.calls, "", "gh pr merge не должен вызываться");
});

test("вердикт для другого коммита не принимается", (t) => {
  // This is the failure the sha check exists for: the branch moved after it was verified, so the
  // verdict describes code that is no longer in the pull request.
  const result = runMergeGate(t, {
    sha: "b".repeat(40),
    verdict: { sha: "a".repeat(40), branch: "feature/x", status: "passed", exit: 0 },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ветка изменилась после проверки|Ветка изменилась/);
  assert.equal(result.calls, "");
});

test("проваленный вердикт не даёт сливать", (t) => {
  const sha = "c".repeat(40);
  const result = runMergeGate(t, { sha, verdict: { sha, branch: "feature/x", status: "failed", exit: 1 } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /слияние запрещено/i);
  assert.equal(result.calls, "");
});

test("расхождение между GitHub и origin слияние останавливает", (t) => {
  // Found by using the gate on itself: the PR head GitHub reported was one commit behind the
  // branch, so the verdict check passed for a commit that was no longer the tip. The remote is the
  // authority for where a branch is, and a disagreement is refused rather than resolved.
  const sha = "e".repeat(40);
  const result = runMergeGate(t, {
    sha,
    remoteSha: "f".repeat(40),
    verdict: { sha, branch: "feature/x", status: "passed", exit: 0 },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /устарел|расхождени/i);
  assert.equal(result.calls, "", "gh pr merge не должен вызываться");
});

test("быстрый вердикт без e2e слияние не разрешает", (t) => {
  // A quick verdict runs the unit suites and skips the end-to-end ones: it says nothing about the
  // product having been RUN, which is the first of the four conditions.
  const sha = "a".repeat(40);
  const result = runMergeGate(t, {
    sha,
    verdict: { sha, branch: "feature/x", status: "passed", exit: 0, mode: "quick", unitTestsPassed: "192", e2eSuitesPassed: "0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /быстрый/);
  assert.equal(result.calls, "", "gh pr merge не должен вызываться");
});

test("пройденный полный вердикт для этого же коммита слияние разрешает", (t) => {
  const sha = "d".repeat(40);
  const result = runMergeGate(t, {
    sha,
    verdict: { sha, branch: "feature/x", status: "passed", exit: 0, mode: "full", unitTestsPassed: "192", e2eSuitesPassed: "10" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /192/);
  assert.match(result.calls, /pr merge 7/);
});
