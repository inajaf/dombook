#!/usr/bin/env bash
# Point git at the hooks this repository carries.
#
# `.git/hooks` is not tracked, so a hook that lives there reaches nobody. The hooks are committed
# under `.githooks/` and git is told to look there, which is one setting per clone — installed by
# `npm install` (see package.json) and re-checked by scripts/check-all.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

git config core.hooksPath .githooks
echo "git hooks: core.hooksPath=.githooks"
