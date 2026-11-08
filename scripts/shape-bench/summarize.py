#!/usr/bin/env python3
"""Shape test, context-level summary, as preregistered.

usage: summarize.py <shape-test/context dir> [--md out.md]
Support recall: supported = 1, partial = 0.5, absent = 0. Primary: non-run facts.
Run-result facts (regex fixed before measurement) are reported separately.
"""
import json, glob, re, sys, statistics as st
from collections import defaultdict

RUN = re.compile(r'\b(test|tests|tested|run|runs|ran|pass|passed|passing|fail|failed|failing|typecheck|lint|build|suite|green|verified)\b', re.I)
SCORE = {'supported': 1.0, 'partial': 0.5, 'absent': 0.0}
d = sys.argv[1]
rows = [json.load(open(f)) for f in sorted(glob.glob(f'{d}/ratings/*.json'))]
# (case, arm, judge) -> per-fact score dict, traps invited, tokens
cell = {}
for r in rows:
    text = {f['id']: f['text'] for f in r['facts']}
    facts = {x['id']: SCORE[x['support']] for x in r['reply']['facts'] if x['id'] in text}
    run = {k for k in facts if RUN.search(text[k])}
    traps = [x['invites'] for x in r['reply']['traps']]
    cell[(r['case'], r['arm'], r['judge'])] = dict(facts=facts, run=run, traps=traps, tokens=r['tokens'], n=len(text))
cases = sorted({k[0] for k in cell})
judges = sorted({k[2] for k in cell})
arms = sorted({k[1] for k in cell})
out = ['# Shape test: context-level fact support', '',
       f'Cases: {", ".join(cases)}. Judges: {", ".join(judges)}. Supported = 1, partial = 0.5.', '']

def recall(c, keys):
    xs = [c['facts'][k] for k in keys if k in c['facts']]
    return sum(xs) / len(xs) if xs else None

summary = {}
for j in judges:
    out += [f'## {j}', '', '| case | G tokens | R tokens | G non-run recall | R non-run recall | winner | G run recall | R run recall | G traps invited | R traps invited |', '|---|---|---|---|---|---|---|---|---|---|']
    gw = rw = ties = 0
    tot = {a: {'nr': [], 'r': [], 'traps': [], 'tok': [], 'sup': 0.0} for a in arms}
    for c in cases:
        g, r = cell.get((c, 'G', j)), cell.get((c, 'R', j))
        if not g or not r:
            continue
        nonrun = [k for k in g['facts'] if k not in g['run']]
        runk = [k for k in g['facts'] if k in g['run']]
        gn, rn = recall(g, nonrun), recall(r, nonrun)
        gr, rr = recall(g, runk), recall(r, runk)
        win = 'G' if gn > rn else 'R' if rn > gn else 'tie'
        gw += win == 'G'; rw += win == 'R'; ties += win == 'tie'
        for a, x in (('G', g), ('R', r)):
            tot[a]['nr'] += [x['facts'][k] for k in nonrun if k in x['facts']]
            tot[a]['r'] += [x['facts'][k] for k in runk if k in x['facts']]
            tot[a]['traps'] += x['traps']
            tot[a]['tok'].append(x['tokens'])
            tot[a]['sup'] += sum(x['facts'][k] for k in nonrun if k in x['facts'])
        out.append(f"| {c} | {g['tokens']} | {r['tokens']} | {gn:.2f} | {rn:.2f} | {win} | {gr if gr is None else f'{gr:.2f}'} | {rr if rr is None else f'{rr:.2f}'} | {sum(g['traps'])}/{len(g['traps'])} | {sum(r['traps'])}/{len(r['traps'])} |")
    m = lambda xs: sum(xs) / len(xs) if xs else float('nan')
    out += ['', f"**All cases, {j}:** non-run recall G {m(tot['G']['nr']):.3f} vs R {m(tot['R']['nr']):.3f}; run-fact recall G {m(tot['G']['r']):.3f} vs R {m(tot['R']['r']):.3f}; "
            f"trap-invite rate G {m(tot['G']['traps']):.3f} vs R {m(tot['R']['traps']):.3f}; per-case wins G {gw}, R {rw}, ties {ties}; "
            f"tokens per supported non-run fact G {sum(tot['G']['tok']) / max(tot['G']['sup'], 1e-9):.0f} vs R {sum(tot['R']['tok']) / max(tot['R']['sup'], 1e-9):.0f}.", '']
    summary[j] = dict(g=m(tot['G']['nr']), r=m(tot['R']['nr']), gt=m(tot['G']['traps']), rt=m(tot['R']['traps']), gw=gw, rw=rw)

# Judge agreement: same (case, arm, fact) rated identically by both judges.
if len(judges) == 2:
    same = n = 0
    for (c, a, j), x in cell.items():
        if j != judges[0]:
            continue
        y = cell.get((c, a, judges[1]))
        if not y:
            continue
        for k, v in x['facts'].items():
            if k in y['facts']:
                n += 1; same += v == y['facts'][k]
    out += [f'Judge agreement (identical rating for the same fact and context): {same}/{n} = {same / max(n, 1):.0%}.', '']

g_better = all(s['g'] > s['r'] and s['gw'] > s['rw'] and s['gt'] <= s['rt'] for s in summary.values())
r_better = all(s['r'] >= s['g'] for s in summary.values())
out += ['## Decision rule, measure 1 (fact support)', '',
        '- Supports H1 if, on both judges, G\'s non-run recall is higher, G wins more cases than R, and G\'s trap-invite rate is no higher.',
        f"- Result: **{'supports H1' if g_better else 'R matches or beats G (refutes on this measure)' if r_better else 'mixed (inconclusive on this measure)'}**.", '']
text = '\n'.join(out) + '\n'
print(text)
if '--md' in sys.argv:
    open(sys.argv[sys.argv.index('--md') + 1], 'w').write(text)
