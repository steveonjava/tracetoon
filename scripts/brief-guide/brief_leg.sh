#!/bin/bash
# One leg of the brief-guide round: harness prbench-score@1422e36 (clean worktree),
# fixed minimal environment, a shared cache per provider so a model's control and
# candidate legs share base writes.
# usage: brief_leg.sh <claude|codex> <skill> <leg> [--plan|--resume|...]
set -u
provider=$1; skill=$2; leg=$3; shift 3
R=/var/home/steve/Development/prbench/results
H=/home/steve/.claude/jobs/d955bb9a/tmp/harness2
case $provider in
  claude) models=claude-haiku-5-5@low ;;
  codex) models=gpt-6-luna@low ;;
  *) echo "provider?"; exit 2 ;;
esac
cd "$H" || exit 2
exec env -i HOME=/home/steve USER=steve LOGNAME=steve SHELL=/bin/bash LANG=en_US.UTF-8 \
  PATH=/home/steve/.local/bin:/home/steve/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin \
  TMPDIR=/var/tmp PWD="$H" PRBENCH_WRITER_TIMEOUT_MS=3600000 PRBENCH_JUDGE_TIMEOUT_MS=1800000 \
  bun run src/cli.ts compare --provider "$provider" --models "$models" \
  --systems baseline,candidate --replicates 5 --purpose diagnostic \
  --baseline-skill $R/evgraph-skills/baseline --candidate-skill $R/evgraph-skills/$skill \
  --dataset real-cases@1.0.0 --split dev --parallel 6 \
  --cache $R/brief-guide/$provider/.prbench-cache-own \
  --out $R/brief-guide/$provider/$leg "$@"
