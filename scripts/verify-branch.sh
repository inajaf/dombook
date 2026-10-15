#!/usr/bin/env bash
# Independent verification of a ref, with a verdict you can hand to whoever merges.
#
#   scripts/verify-branch.sh [ref] [--quick]
#
# WHY THIS IS A SEPARATE SCRIPT AND NOT `check-all.sh`
#
# `check-all.sh` answers "is this checkout good". It runs against the working tree the author has
# been editing, with whatever is uncommitted, whatever is installed, and whatever state the last
# experiment left behind. That is the right tool while writing code and the wrong tool for a
# verdict: "it passed on my machine" is not evidence about a commit.
#
# This runs the SAME gate in a CLEAN WORKTREE of the ref being verified. Two things follow, and
# both are the point:
#
#   * the result is about a COMMIT, not about a directory — the verdict names the sha, and a
#     verdict for a different sha is not accepted by scripts/merge-verified.sh;
#   * the author's uncommitted work cannot pass the gate on the author's behalf.
#
# The evidence lands in artifacts/, which is gitignored: a verdict is about a moment, not a file
# anybody should commit.
#
# The e2e suites drive the REAL app over the DevTools Protocol — they build, install, launch,
# click, and read the database. That is the "hands and eyes" half: a green verdict here means the
# product was run, not that it compiled.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REF="${1:-HEAD}"
MODE="${2:-}"
ROOT="$(pwd)"
ARTIFACTS="${ROOT}/artifacts"
QUICK=0
[ "$MODE" = "--quick" ] && QUICK=1

# The e2e stack owns fixed ports and one database, so two verifications cannot overlap and neither
# can share a machine with a running stack. Refusing is better than a verdict nobody can trust.
if curl -sf http://127.0.0.1:8787/health >/dev/null 2>&1 || curl -sf http://127.0.0.1:9555/json/list >/dev/null 2>&1; then
  echo "verify-branch: стек уже запущен (порт 8787 или 9555 занят)." >&2
  echo "  Остановите его: scripts/e2e-stack.sh down" >&2
  exit 2
fi

SHA="$(git rev-parse "$REF")"
SHORT="$(git rev-parse --short "$SHA")"
BRANCH="$(git for-each-ref --points-at "$SHA" --format='%(refname:short)' refs/heads refs/remotes 2>/dev/null | head -1)"
[ -z "$BRANCH" ] && BRANCH="detached"
BRANCH="${BRANCH#origin/}"
WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/rentkeeper-verify.XXXXXX")"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "=== независимая проверка ${BRANCH} @ ${SHORT} ==="
echo "  чистая копия: ${WORKTREE}"

cleanup() {
  # The stack is stopped first: it holds the ports the NEXT verification needs, and a worktree
  # removed under a running app leaves a process writing to a deleted directory.
  "${WORKTREE}/scripts/e2e-stack.sh" down >/dev/null 2>&1 || true
  git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
}
trap cleanup EXIT

if ! git worktree add --detach "$WORKTREE" "$SHA" >/dev/null 2>&1; then
  echo "verify-branch: не удалось создать чистую копию для ${SHA}" >&2
  exit 2
fi

# A clean worktree has no node_modules and no database of its own; the dependencies are shared by
# symlink so the verification does not re-download the world, and the database comes from the
# Docker container the repository already uses.
if [ -d "${ROOT}/node_modules" ] && [ ! -e "${WORKTREE}/node_modules" ]; then
  ln -s "${ROOT}/node_modules" "${WORKTREE}/node_modules"
fi

LOG="${ARTIFACTS}/verify-${SHORT}.log"
mkdir -p "$ARTIFACTS"

if [ "$QUICK" -eq 1 ]; then
  echo "  режим: быстрый (без e2e-сьютов)" | tee "$LOG"
  ( cd "$WORKTREE" && bash scripts/check-all.sh ) >>"$LOG" 2>&1
else
  echo "  режим: полный (с e2e-сьютами)" | tee "$LOG"
  ( cd "$WORKTREE" && bash scripts/check-all.sh --e2e ) >>"$LOG" 2>&1
fi
STATUS=$?
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# The evidence is read back OUT of the log rather than assumed from the exit code: a verdict that
# says "passed" without saying what ran is a claim, not evidence.
grep -E "^  (✔|✘)|^ALL CHECKS PASSED|^[0-9]+ CHECK\(S\) FAILED|^--- ok:|^--- FAILED:" "$LOG" > "${ARTIFACTS}/verify-${SHORT}.steps" 2>/dev/null || true
UNITS="$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$LOG" | tail -1)"
SUITES="$(grep -c "^  ✔" "${ARTIFACTS}/verify-${SHORT}.steps" 2>/dev/null | head -1)"
[ -z "$SUITES" ] && SUITES=0

cat > "${ARTIFACTS}/verdict-${SHORT}.md" <<VERDICT
# Verdict — ${BRANCH} @ ${SHORT}

$( [ "$STATUS" -eq 0 ] && echo "**PASSED**" || echo "**FAILED** (exit ${STATUS})" )

| | |
|---|---|
| commit | \`${SHA}\` |
| branch | \`${BRANCH}\` |
| started | ${STARTED} |
| finished | ${FINISHED} |
| mode | $( [ "$QUICK" -eq 1 ] && echo "quick (no e2e)" || echo "full (e2e suites)" ) |
| unit tests passed | ${UNITS:-unknown} |
| e2e suites passed | ${SUITES} |

Verified in a clean worktree, not in the author's tree. The e2e suites build, install and launch the
real application and drive it over the DevTools Protocol, so this verdict is about behaviour that
was run, not about code that compiled.

Full log: \`artifacts/verify-${SHORT}.log\`
VERDICT

# A machine-readable copy, so the merge gate can check the sha and the result without parsing prose.
printf '{"sha":"%s","branch":"%s","status":"%s","exit":%d,"started":"%s","finished":"%s","mode":"%s","unitTestsPassed":"%s","e2eSuitesPassed":"%s"}\n' \
  "$SHA" "$BRANCH" "$( [ "$STATUS" -eq 0 ] && echo passed || echo failed )" "$STATUS" "$STARTED" "$FINISHED" \
  "$( [ "$QUICK" -eq 1 ] && echo quick || echo full )" "${UNITS:-}" "${SUITES}" \
  > "${ARTIFACTS}/verdict-${SHORT}.json"

echo
if [ "$STATUS" -eq 0 ]; then
  echo "ВЕРДИКТ: ПРОЙДЕНО — ${BRANCH} @ ${SHORT}"
else
  echo "ВЕРДИКТ: ПРОВАЛЕНО — ${BRANCH} @ ${SHORT}"
  echo "  последние строки:"
  tail -12 "$LOG" | sed 's/^/    /'
fi
echo "  доказательства: artifacts/verdict-${SHORT}.md"
exit "$STATUS"
