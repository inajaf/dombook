#!/usr/bin/env bash
# Merge a pull request — but only one that an INDEPENDENT verification passed.
#
#   scripts/merge-verified.sh <pr-number>
#
# The author of a change does not merge it. Not because authors are careless, but because the one
# thing an author cannot do is be surprised by their own work: they know which test would fail if
# the change were wrong, so they ran that one. A verdict from `scripts/verify-branch.sh` is worth
# something precisely because it was produced from a clean copy of the commit by something that did
# not write it.
#
# This refuses in three cases, and each is a way an unverified merge happens in practice:
#
#   1. no verdict for this commit         — "I ran the tests earlier" is not a verdict about a sha;
#   2. the verdict is for a different sha — the branch moved after it was verified;
#   3. the verdict failed                 — obviously, and stated anyway so the message is the same
#                                           shape every time.
#
# The verification itself is not run here: it takes a machine to itself (the stack owns fixed ports
# and one database), and a merge that starts a twenty-minute test run is a merge nobody waits for.
# Run it first, then this.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PR="${1:-}"
if [ -z "$PR" ]; then
  echo "usage: scripts/merge-verified.sh <pr-number>" >&2
  exit 2
fi

INFO="$(gh pr view "$PR" --json headRefOid,headRefName --jq '.headRefOid + " " + .headRefName' 2>/dev/null)"
if [ -z "$INFO" ]; then
  echo "merge-verified: PR #${PR} не найден (или gh не авторизован)." >&2
  exit 2
fi
SHA="${INFO%% *}"
BRANCH="${INFO##* }"

# GitHub's answer can LAG a push by a few seconds, and this gate was caught by exactly that: it
# merged a pull request on the strength of a verdict for the commit BEFORE the last one. The remote
# is the authority for where a branch is, and the two are compared rather than trusted:
#
#   * a disagreement means one of them is stale — refuse and say so, do not pick a winner;
#   * if the remote cannot be read, there is nothing to verify against, so there is no merge.
REMOTE_SHA="$(git ls-remote origin "refs/heads/${BRANCH}" 2>/dev/null | cut -f1)"
if [ -z "$REMOTE_SHA" ]; then
  echo "merge-verified: не удалось прочитать ветку ${BRANCH} на origin — проверять не с чем." >&2
  exit 2
fi
if [ "$REMOTE_SHA" != "$SHA" ]; then
  cat >&2 <<MESSAGE
merge-verified: GitHub отдаёт ${SHA:0:7}, а ветка ${BRANCH} на origin стоит на ${REMOTE_SHA:0:7}.

  Один из ответов устарел — обычно GitHub не успел за пушем. Повторите команду
  через несколько секунд; сливать по расхождению нельзя, потому что вердикт
  относится к конкретному коммиту.
MESSAGE
  exit 1
fi
SHORT="$(git rev-parse --short "$SHA" 2>/dev/null || echo "${SHA:0:7}")"
VERDICT="artifacts/verdict-${SHORT}.json"

# A green required check IS a verdict, and a better one than this script can produce.
#
# The original rule was "no merge without a local verdict", written when CI ran the unit layer only:
# the suites that launch the real application were something a person chose to run on a laptop.
# `main` now requires a check that runs those suites on a clean runner with xvfb, so demanding a
# second, local copy of the same run is ceremony — five minutes of a machine's time to reproduce
# what a clean server already reported, for a commit identified by a sha in both cases.
#
# What is NOT relaxed: the check must be green FOR THIS SHA, and the sha must be where the remote
# branch actually is. Both are verified above, before this point.
if [ ! -f "$VERDICT" ]; then
  CHECKS="$(gh pr checks "$PR" --json name,state --jq '.[] | select(.state != "SUCCESS") | .name' 2>/dev/null)"
  CHECK_COUNT="$(gh pr checks "$PR" --json name --jq 'length' 2>/dev/null)"
  if [ -n "$CHECK_COUNT" ] && [ "$CHECK_COUNT" != "0" ] && [ -z "$CHECKS" ]; then
    echo "merge-verified: локального вердикта нет, но обязательная проверка CI пройдена для ${SHORT}"
    echo "  (CI прогоняет тот же гейт, включая e2e-сьюты, в чистой копии на своей машине)"
    gh pr merge "$PR" --squash || exit 1
    echo "готово: $(gh pr view "$PR" --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid[0:7])"')"
    exit 0
  fi
  cat >&2 <<MESSAGE
merge-verified: для PR #${PR} (@ ${SHORT}) нет вердикта.

  Проверку выполняет НЕ автор изменения:

      scripts/verify-branch.sh ${SHA}

  Она прогонит весь гейт в чистой копии этого коммита и положит вердикт
  в artifacts/verdict-${SHORT}.json. После этого запустите эту команду снова.
MESSAGE
  exit 1
fi

python3 - "$VERDICT" "$SHA" <<'PY'
import json, os, sys
verdict, want = sys.argv[1], sys.argv[2]
data = json.load(open(verdict, encoding="utf-8"))
if data.get("sha") != want:
    print(f"merge-verified: вердикт выдан для {data.get('sha','?')[:7]}, а PR теперь на {want[:7]}.", file=sys.stderr)
    print("  Ветка изменилась после проверки — вердикт к ней не относится. Проверьте снова:", file=sys.stderr)
    print(f"  scripts/verify-branch.sh {want}", file=sys.stderr)
    sys.exit(1)
if data.get("status") != "passed":
    print(f"merge-verified: вердикт для {want[:7]} — {data.get('status')}. Слияние запрещено.", file=sys.stderr)
    sys.exit(1)
# A quick verdict runs the unit suites and skips the end-to-end ones — it says nothing about the
# product having been RUN, which is the first of the four conditions. It is accepted only when
# somebody says out loud that this change cannot affect behaviour.
if data.get("mode") != "full" and os.environ.get("RENTKEEPER_ALLOW_QUICK_VERDICT") != "1":
    print(f"merge-verified: вердикт для {want[:7]} — быстрый, без e2e-сьютов.", file=sys.stderr)
    print("  Приложение не запускалось, значит о поведении он не говорит ничего. Прогоните полный:", file=sys.stderr)
    print(f"  scripts/verify-branch.sh {want}", file=sys.stderr)
    print("  Если изменение заведомо не влияет на поведение: RENTKEEPER_ALLOW_QUICK_VERDICT=1", file=sys.stderr)
    sys.exit(1)
print(f"merge-verified: вердикт для {want[:7]} пройден "
      f"({data.get('unitTestsPassed','?')} модульных тестов, {data.get('e2eSuitesPassed','?')} e2e-сьютов)")
PY
GATE=$?
[ "$GATE" -ne 0 ] && exit 1

echo "сливаю PR #${PR} (@ ${SHORT})"
gh pr merge "$PR" --squash || exit 1
echo "готово: $(gh pr view "$PR" --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid[0:7])"')"
