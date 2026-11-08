#!/usr/bin/env python3
"""Summarize bench-engines.ts results (bench-results.jsonl) as markdown.

usage: bench-report.py <bench-results.jsonl> [--md out.md]
Tables: the PR workload (W1) on real graphs grouped by size; each multi-hop
query (W2) by graph, with cypherlite vs SQLite latency, the ratio, peak wasm
memory, and failures; answer mismatches; and the outcome-B check (fixed in
advance): where cypherlite's latency or memory grows more slowly than SQLite's.
"""
import json
import re
import statistics as st
import sys
from collections import defaultdict

path = sys.argv[1]
md_out = sys.argv[sys.argv.index('--md') + 1] if '--md' in sys.argv else None
rows = [json.loads(l) for l in open(path) if l.strip()]
mism = [r for r in rows if r.get('mismatch')]
cells = [r for r in rows if not r.get('mismatch')]
label = lambda g: re.sub(r'.*/(real|synthetic)/', r'\1/', g).replace('/evidence-graph.json', '')
mb = lambda b: f'{b / 1048576:,.0f}' if b else '—'
ms = lambda x: '—' if x is None else (f'{x:,.0f}' if x >= 10 else f'{x:.1f}')
out = ['# Engine benchmark: cypherlite vs SQLite (both WebAssembly)', '']

# Telemetry: clock-stubbed cypherlite vs normal.
pairs = defaultdict(dict)
for r in cells:
    if r.get('coldMs') is not None and r['engine'] in ('graph', 'graph-noclock'):
        pairs[(r['graph'], r['query'])][r['engine']] = r.get('warmMedianMs') or r['coldMs']
ratios = [v['graph-noclock'] / v['graph'] for v in pairs.values() if 'graph' in v and 'graph-noclock' in v and v['graph'] > 1]
if ratios:
    out += [f'cypherlite with its statement clocks stubbed (telemetry-off proxy) vs normal: median time ratio {st.median(ratios):.3f} over {len(ratios)} cells.', '']

# W1: PR workload by graph size.
w1 = defaultdict(lambda: defaultdict(list))
for r in cells:
    if r['query'] == 'pr' and r.get('coldMs') is not None:
        n = r['nodes']
        band = '≤40 nodes' if n <= 40 else '41–400 nodes' if n <= 400 else '>400 nodes'
        w1[band][r['engine']].append(r)
out += ['## W1: the PR workload (brief, derive, every named query), real graphs', '',
        '| graphs | engine | n | load ms (median) | workload ms warm (median) | wasm MB peak (median) | RSS MB (median) |', '|---|---|---|---|---|---|---|']
for band in ['≤40 nodes', '41–400 nodes', '>400 nodes']:
    for eng in ['graph', 'graph-noclock', 'sqlite']:
        rs = w1[band].get(eng, [])
        if not rs:
            continue
        out.append(f"| {band} | {eng} | {len(rs)} | {ms(st.median(r['loadMs'] for r in rs))} | {ms(st.median((r.get('warmMedianMs') or r['coldMs']) for r in rs))} | {mb(st.median(r['wasmBytesPeak'] or 0 for r in rs))} | {st.median(r['maxRssKB'] for r in rs) / 1024:,.0f} |")
out.append('')

# W2: multi-hop by graph.
w2 = defaultdict(dict)
for r in cells:
    if r['query'] != 'pr':
        w2[(r['graph'], r['query'])][r['engine']] = r
graphs = sorted({g for g, _ in w2}, key=lambda g: next((r.get('nodes') or 0 for r in w2[(g, q)].values() for q in [q] if r.get('nodes')), 0) if False else 0)
by_graph = defaultdict(list)
for (g, q), engs in w2.items():
    by_graph[g].append((q, engs))
size = {g: max((r.get('nodes') or 0) for _, e in v for r in e.values()) for g, v in by_graph.items()}
def qkey(q):
    m = re.match(r'(B\d+\w*)-.*?(\d+)?$', q)
    return (m.group(1), int(m.group(2) or 0)) if m else (q, 0)
b_rows = []
for g in sorted(by_graph, key=lambda g: size[g]):
    out += [f'## W2 multi-hop: {label(g)} ({size[g]:,} nodes)', '',
            '| query | cypherlite ms | SQLite ms (+edge table) | cypherlite / SQLite | cypherlite wasm MB | SQLite wasm MB | answer |', '|---|---|---|---|---|---|---|']
    for q, engs in sorted(by_graph[g], key=lambda x: qkey(x[0])):
        gr, sq = engs.get('graph', {}), engs.get('sqlite', {})
        def t(r):
            if r.get('skipped'):
                return 'skipped'
            if r.get('error'):
                e = r['error']
                return 'timeout' if 'timeout' in e else ('trap at ' + mb(r.get('wasmBytesAtFailure')) + ' MB' if r.get('wasmBytesAtFailure') else 'failed')
            return ms(r.get('warmMedianMs') or r.get('coldMs'))
        gt = gr.get('warmMedianMs') or gr.get('coldMs')
        stt = sq.get('warmMedianMs') or sq.get('coldMs')
        ratio = f'{gt / stt:.2f}×' if gt and stt else '—'
        sqcol = t(sq) + (f" (+{ms(sq.get('edgesMs'))})" if sq.get('edgesMs') else '')
        ans = '' if not (gr.get('result') or sq.get('result')) else ('=' if gr.get('result') == sq.get('result') else 'differ' if gr.get('result') and sq.get('result') else '')
        out.append(f"| {q} | {t(gr)} | {sqcol} | {ratio} | {mb(gr.get('wasmBytesPeak'))} | {mb(sq.get('wasmBytesPeak'))} | {ans} |")
        b_rows.append((q, size[g], gt, stt, gr, sq))
    out.append('')

if mism:
    out += ['## Answer mismatches', ''] + [f"- {label(m['graph'])} {m['query']}: {json.dumps(m['answers'])}" for m in mism] + ['']

# Outcome B: per query family, does cypherlite win or scale better than SQLite?
out += ['## Outcome B check (fixed in advance)', '',
        'B holds for a workload where cypherlite is faster, or its time or memory grows more slowly with graph size or hops, than SQLite\'s.', '',
        '| workload | cypherlite faster in | SQLite faster in | cypherlite failed (timeout/trap) | SQLite failed | B |', '|---|---|---|---|---|---|']
fam = defaultdict(lambda: [0, 0, 0, 0])
for q, n, gt, stt, gr, sq in b_rows:
    f = qkey(q)[0]
    if gt and stt:
        fam[f][0 if gt < stt else 1] += 1
    fam[f][2] += bool(gr.get('error'))
    fam[f][3] += bool(sq.get('error'))
for f, (gw, sw, gf, sf) in sorted(fam.items()):
    holds = gw > sw and gf <= sf
    out.append(f'| {f} | {gw} | {sw} | {gf} | {sf} | {"yes" if holds else "no"} |')
text = '\n'.join(out) + '\n'
print(text)
if md_out:
    open(md_out, 'w').write(text)
