#!/bin/bash
# One leg of the graph / relational / base trio, launched with a fixed minimal
# environment from a clean harness worktree (prbench-score@0986e26). prbench's
# writer cache keys and experiment identity hash the controller environment,
# so a fixed environment keeps runs resumable and lets both candidate legs of a
# provider share one set of base writes (one cache under evgraph-trio/).
#
# usage: token_leg.sh <claude|codex> <skill> <leg> [--plan|--resume|...]  (out: evgraph-trio/<provider>-<leg>)
set -u
provider=$1; skill=$2; leg=$3; shift 3
R=/var/home/steve/Development/prbench/results
H=/home/steve/.claude/jobs/d955bb9a/tmp/harness
case $provider in
  claude) models=claude-haiku-5-5@low,claude-sonnet-5-5@medium ;;
  codex) models=gpt-6-luna@low,gpt-6.1-terra@medium ;;
  *) echo "provider?"; exit 2 ;;
esac
# leg name given explicitly (token test)
cd "$H" || exit 2
exec env -i HOME=/home/steve USER=steve LOGNAME=steve SHELL=/bin/bash LANG=en_US.UTF-8 \
  PATH=/home/steve/.local/bin:/home/steve/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin \
  TMPDIR=/var/tmp PWD="$H" \
  bun run src/cli.ts compare --provider "$provider" --models "$models" \
  --systems baseline,candidate --replicates 3 --purpose diagnostic \
  --baseline-skill $R/evgraph-skills/baseline --candidate-skill $R/evgraph-skills/$skill \
  --dataset real-cases@1.0.0 --split dev --parallel 4 \
  --out $R/evgraph-trio/$provider-$leg "$@"
