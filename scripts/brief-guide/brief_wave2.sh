#!/bin/bash
# Launch a model's candidate leg once its control leg has written all 25 base drafts
# and a dry run shows 25/25 base hits. usage: brief_wave2.sh <provider> <control-leg> <skill> <leg>
P=/var/home/steve/Development/prbench/results/brief-guide; J=/home/steve/.claude/jobs/d955bb9a/tmp
prov=$1; ctl=$2; skill=$3; leg=$4; LOG=$P/waves.log
for i in $(seq 1 360); do
  n=$(find $P/$prov/$ctl/attempts/writer -name tracetoon-baseline.json 2>/dev/null | wc -l)
  [ "$n" -ge 25 ] && break; sleep 30
done
plan=$($J/brief_leg.sh $prov $skill $leg --plan 2>/dev/null)
hits=$(printf '%s' "$plan" | python3 -c "
import json,sys
t=sys.stdin.read(); p=json.loads(t[t.index('{'):]); print(sum(1 for j in p['jobs'] if j['system']=='tracetoon-baseline' and j['reuse']))" 2>/dev/null)
echo "$(date -Is) $prov/$ctl base drafts=$n; $leg dry-run base hits=$hits" >> $LOG
if [ "$hits" = "25" ]; then
  echo "\$ brief-guide $prov $leg skill=$skill (candidate; shares $ctl base) $(date -Is)" > $P/$prov/$leg.log
  setsid nohup $J/brief_leg.sh $prov $skill $leg >> $P/$prov/$leg.log 2>&1 < /dev/null &
  echo "$(date -Is) launched $prov/$leg" >> $LOG
else
  echo "$(date -Is) NOT launched $prov/$leg: base hits $hits (gate needs 25)" >> $LOG
fi
