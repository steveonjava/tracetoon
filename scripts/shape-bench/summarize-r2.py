#!/usr/bin/env python3
"""Round-2 diagnostics: each R variant vs G (round-1 ratings), same metrics as summarize.py.
usage: summarize-r2.py <context dir>... [--md out.md]  (round 1 first; later rounds add arms)"""
import json, glob, re, sys
RUN = re.compile(r'\b(test|tests|tested|run|runs|ran|pass|passed|passing|fail|failed|failing|typecheck|lint|build|suite|green|verified)\b', re.I)
SCORE = {'supported': 1.0, 'partial': 0.5, 'absent': 0.0}
cell = {}
dirs = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith('--') and sys.argv[i - 1] != '--md']
for d in dirs:
    for f in glob.glob(f'{d}/ratings/*.json'):
        r = json.load(open(f)); text = {x['id']: x['text'] for x in r['facts']}
        facts = {x['id']: SCORE[x['support']] for x in r['reply']['facts'] if x['id'] in text}
        ctxf = f"{d}/contexts/{r['case']}/{r['arm']}.json"
        try: ctoks = json.load(open(ctxf)).get('contextTokens')
        except Exception: ctoks = None
        cell[(r['case'], r['arm'], r['judge'])] = dict(facts=facts, run={k for k in facts if RUN.search(text[k])}, traps=[x['invites'] for x in r['reply']['traps']], tokens=r['tokens'])
cases = sorted({k[0] for k in cell}); judges = sorted({k[2] for k in cell})
arms = ['G', 'R', 'R-matched', 'R-flat', 'R-flat-matched', 'GN']
gate = {}
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
        gate.setdefault(j, {})[a] = dict(nr=m(nr), tr=m(tr))
    out.append('')
# GN vs R per case (the round-3 gate's second condition)
if any('GN' in g for g in gate.values()):
    out += ['## Round-3 gate: GN vs R (see context-r3/GATE.md)', '']
    ok_all = True
    for j in judges:
        w = l = 0
        for c in cases:
            x, r, g = cell.get((c, 'GN', j)), cell.get((c, 'R', j)), cell.get((c, 'G', j))
            if not x or not r or not g: continue
            keys = [k for k in g['facts'] if k not in g['run']]
            xa = m([x['facts'][k] for k in keys if k in x['facts']]); ra = m([r['facts'][k] for k in keys if k in r['facts']])
            w += xa > ra; l += xa < ra
        G = gate[j]
        c1 = G['GN']['nr'] > G['R']['nr']; c2 = w > l; c3 = G['GN']['tr'] <= G['R']['tr']
        ok_all &= c1 and c2 and c3
        out.append(f"- {j}: recall GN {G['GN']['nr']:.3f} vs R {G['R']['nr']:.3f} ({'pass' if c1 else 'fail'}); cases GN {w} / R {l} ({'pass' if c2 else 'fail'}); trap rate GN {G['GN']['tr']:.3f} vs R {G['R']['tr']:.3f} ({'pass' if c3 else 'fail'})")
    out += ['', f"**Gate: {'PASSED' if ok_all else 'NOT PASSED'}.**", '']
text = '\n'.join(out) + '\n'; print(text)
if '--md' in sys.argv: open(sys.argv[sys.argv.index('--md') + 1], 'w').write(text)
