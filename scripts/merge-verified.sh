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

SHA="$(gh pr view "$PR" --json headRefOid --jq .headRefOid 2>/dev/null)"
if [ -z "$SHA" ]; then
  echo "merge-verified: PR #${PR} не найден (или gh не авторизован)." >&2
  exit 2
fi
SHORT="$(git rev-parse --short "$SHA" 2>/dev/null || echo "${SHA:0:7}")"
VERDICT="artifacts/verdict-${SHORT}.json"

if [ ! -f "$VERDICT" ]; then
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
import json, sys
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
print(f"merge-verified: вердикт для {want[:7]} пройден "
      f"({data.get('unitTestsPassed','?')} модульных тестов, {data.get('e2eSuitesPassed','?')} e2e-сьютов)")
PY
GATE=$?
[ "$GATE" -ne 0 ] && exit 1

echo "сливаю PR #${PR} (@ ${SHORT})"
gh pr merge "$PR" --squash || exit 1
echo "готово: $(gh pr view "$PR" --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid[0:7])"')"
