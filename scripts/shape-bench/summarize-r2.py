#!/usr/bin/env python3
"""Round-2 diagnostics: each R variant vs G (round-1 ratings), same metrics as summarize.py.
usage: summarize-r2.py <round-1 context dir> <round-2 context dir> [--md out.md]"""
import json, glob, re, sys
RUN = re.compile(r'\b(test|tests|tested|run|runs|ran|pass|passed|passing|fail|failed|failing|typecheck|lint|build|suite|green|verified)\b', re.I)
SCORE = {'supported': 1.0, 'partial': 0.5, 'absent': 0.0}
cell = {}
for d in sys.argv[1:3]:
    for f in glob.glob(f'{d}/ratings/*.json'):
        r = json.load(open(f)); text = {x['id']: x['text'] for x in r['facts']}
        facts = {x['id']: SCORE[x['support']] for x in r['reply']['facts'] if x['id'] in text}
        ctxf = f"{d}/contexts/{r['case']}/{r['arm']}.json"
        try: ctoks = json.load(open(ctxf)).get('contextTokens')
        except Exception: ctoks = None
        cell[(r['case'], r['arm'], r['judge'])] = dict(facts=facts, run={k for k in facts if RUN.search(text[k])}, traps=[x['invites'] for x in r['reply']['traps']], tokens=r['tokens'])
cases = sorted({k[0] for k in cell}); judges = sorted({k[2] for k in cell})
arms = ['G', 'R', 'R-matched', 'R-flat', 'R-flat-matched']
m = lambda xs: sum(xs) / len(xs) if xs else float('nan')
out = ['# Shape test round 2: R variants vs G (context-level fact support)', '',
       '- R-matched: R packed to each case\'s G evidence size. R-flat: R without join or search links (no "→"/"why" adjacency; embeddings still rank). R-flat-matched: both.',
       '- Non-run recall: supported = 1, partial = 0.5, over facts that are not run results. Wins/losses: per case vs G on non-run recall.', '']
for j in judges:
    out += [f'## {j}', '', '| arm | non-run recall | trap-invite rate | case wins / losses / ties vs G | mean tokens seen |', '|---|---|---|---|---|']
    for a in arms:
        nr, tr, toks = [], [], []; w = l = t = 0
        for c in cases:
            x, g = cell.get((c, a, j)), cell.get((c, 'G', j))
            if not x or not g: continue
            keys = [k for k in g['facts'] if k not in g['run']]
            nr += [x['facts'][k] for k in keys if k in x['facts']]; tr += x['traps']; toks.append(x['tokens'])
            if a != 'G':
                xa = m([x['facts'][k] for k in keys if k in x['facts']]); ga = m([g['facts'][k] for k in keys if k in g['facts']])
                w += xa > ga; l += xa < ga; t += xa == ga
        if not nr: continue
        out.append(f"| {a} | {m(nr):.3f} | {m(tr):.3f} | {'—' if a == 'G' else f'{w} / {l} / {t}'} | {m(toks):.0f} |")
    out.append('')
text = '\n'.join(out) + '\n'; print(text)
if '--md' in sys.argv: open(sys.argv[sys.argv.index('--md') + 1], 'w').write(text)
