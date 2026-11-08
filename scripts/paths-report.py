#!/usr/bin/env python3
"""Summarize bench-paths.ts results: per question and form, cypherlite vs SQLite
latency by graph size, the correctness checks, and the criterion fixed in advance
(cypherlite p50 below SQLite's on >= 80% of graphs with 100+ nodes, for >= 2 of 3
questions, with every answer matching).

usage: paths-report.py <paths-results.jsonl> [--json chart-data.json]
"""
import json
import statistics as st
import sys
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
checks = [r for r in rows if r.get('check')]
cells = [r for r in rows if not r.get('check')]
by = defaultdict(dict)
for r in cells:
    by[(r['graph'], r['question'], r['variant'])][r['engine']] = r

QS = ['Q1-prompt-to-hunk', 'Q2-commit-to-prompt', 'Q3-file-to-file']
FORMS = ['path-bfs', 'len', 'path']
print(f"Answers checked: {sum(c['agree'] + c['disagree'] for c in checks)}; engines disagree: {sum(c['disagree'] for c in checks)}; invalid paths: {sum(c['invalid'] for c in checks)}")
chart = []
holds_by_form = {}
for form in FORMS:
    print(f'\n## form: {form}')
    wins = 0
    for q in QS:
        big = sorted(((e.get('graph', e.get('sqlite'))['nodes'], e) for (g, qq, v), e in by.items() if qq == q and v == form and (e.get('graph') or e.get('sqlite'))['nodes'] >= 100), key=lambda x: x[0])
        faster = 0
        line = []
        # A graph with no pairs for this question (e.g. no commits) has nothing to compare.
        big = [(n, e) for n, e in big if e.get('graph', {}).get('pairsAsked')]
        for n, e in big:
            gp = e['graph'].get('warmP50')
            sp = e['sqlite'].get('warmP50') if 'sqlite' in e else None
            serr = e.get('sqlite', {}).get('error')
            if gp is not None and (sp is None and serr or sp is not None and gp < sp):
                faster += 1
            line.append(f"{n}n: {gp:.2f} vs {'OOM' if serr else f'{sp:.2f}'} ms")
            chart.append({'form': form, 'question': q, 'nodes': n, 'cypherlite': gp, 'sqlite': sp, 'sqliteError': bool(serr)})
        share = faster / len(big) if big else 0
        wins += share >= 0.8
        small = [e for (g, qq, v), e in by.items() if qq == q and v == form and e.get('graph', {}).get('nodes', 999) < 100 and e.get('graph', {}).get('warmP50') and e.get('sqlite', {}).get('warmP50')]
        sm = f"; small graphs (<100 nodes, n={len(small)}): cypherlite faster in {sum(e['graph']['warmP50'] < e['sqlite']['warmP50'] for e in small)}" if small else ''
        print(f"{q}: cypherlite faster on {faster}/{len(big)} graphs with 100+ nodes  [{'; '.join(line)}]{sm}")
    holds_by_form[form] = wins >= 2
    print(f'criterion for {form}: {"HOLDS" if wins >= 2 else "does not hold"} ({wins}/3 questions)')
if '--json' in sys.argv:
    json.dump(chart, open(sys.argv[sys.argv.index('--json') + 1], 'w'), indent=1)
