#!/usr/bin/env bash
# The router: a goal and a verification condition in, an ordered list of steps out.
#
#   scripts/playbook.sh list
#   scripts/playbook.sh <kind> "<цель>" "<условие проверки>"
#
# The problem this solves is not knowing WHAT to do — it is an agent that knows the goal and
# improvises a procedure for it every time, differently, and reports success against whatever
# procedure it happened to invent. So the procedure is DATA (`playbooks/*.json`), chosen by the
# nature of the work, and the router refuses to start a run whose verification condition is missing.
#
# That refusal is the point. "Make it better" has no exit; "the failing test now passes" does. An
# agent told to improve something will improve something; an agent given a verification condition
# has something to be wrong about.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

KIND="${1:-}"

if [ -z "$KIND" ] || [ "$KIND" = "list" ] || [ "$KIND" = "--help" ]; then
  python3 - <<'PY'
import json, glob, os
print("Плейбуки — выберите по природе работы, а не по названию:\n")
for path in sorted(glob.glob("playbooks/*.json")):
    data = json.load(open(path, encoding="utf-8"))
    print(f"  {data['name']:<10} {data['when']}")
print("\nЗапуск:  scripts/playbook.sh <имя> \"<цель>\" \"<условие проверки>\"")
print("Проверка обязательна: без неё не с чем сверяться, и «готово» становится мнением.")
PY
  exit 0
fi

FILE="playbooks/${KIND}.json"
if [ ! -f "$FILE" ]; then
  echo "playbook: нет плейбука «${KIND}»." >&2
  echo "  Есть: $(ls playbooks/*.json | xargs -n1 basename | sed 's/.json//' | tr '\n' ' ')" >&2
  exit 2
fi

GOAL="${2:-}"
VERIFY="${3:-}"
if [ -z "$GOAL" ]; then
  echo "playbook: нужна цель." >&2
  echo "  scripts/playbook.sh ${KIND} \"что должно стать правдой\" \"как это проверить\"" >&2
  exit 2
fi

mkdir -p artifacts
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="artifacts/playbook-${KIND}-${STAMP}.md"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

python3 - "$FILE" "$GOAL" "$VERIFY" "$OUT" "$BRANCH" <<'PY'
import json, sys
path, goal, verify, out, branch = sys.argv[1:6]
data = json.load(open(path, encoding="utf-8"))

lines = [
    f"# Плейбук: {data['name']}",
    "",
    f"**Цель.** {goal}",
    f"**Проверка.** {verify or '— НЕ ЗАДАНА —'}",
    f"**Ветка.** `{branch}`",
    "",
    f"Плейбук выбран потому что: {data['when']}.",
    f"Условие проверки по умолчанию для этого вида работы: {data['verification']}",
    "",
    "## Шаги",
    "",
]
for i, step in enumerate(data["steps"], 1):
    lines += [f"### {i}. {step['step']}", "", step["do"], "", f"*Доказательство:* {step['evidence']}", ""]
lines += ["## Готово, когда", ""]
lines += [f"- {item}" for item in data["exit"]]
lines += [
    "",
    "## Перед слиянием",
    "",
    "```bash",
    "scripts/check-all.sh --e2e        # внутренняя петля",
    "git push -u origin <ветка> && gh pr create --base main",
    "scripts/verify-branch.sh <sha>    # независимая проверка, чистая копия",
    "scripts/merge-verified.sh <pr>    # без вердикта не сольёт",
    "```",
]
if not verify:
    lines += [
        "",
        "> **Условие проверки не задано.** Это не формальность: без него «готово» — вопрос мнения,",
        "> и работа не может быть закончена, потому что нечему соответствовать. Сформулируйте его",
        "> и запустите плейбук снова.",
    ]

open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("\n".join(lines))
PY

echo
echo "план сохранён: ${OUT}"
if [ -z "$VERIFY" ]; then
  exit 3
fi
