#!/usr/bin/env python3
"""Graph vs relational vs base: quality and cost from a paired prbench trio.

usage: arm-report.py <trio-dir> [--md out.md]
The trio dir holds <provider>-graph and <provider>-relational experiments that
share base writes (one cache). Per provider and model it reports, for each arm:
consensus W-L-T vs base, judged quality metrics, writer cost (USD where the
provider reports it, tokens always), writer seconds, evidence lookups and
engine time/memory from tracetoon's counters. Then a paired graph-vs-relational
comparison on the same base sample per case, and the outcome-A check.
"""
import glob
import json
import os
import statistics as st
import sys
from collections import defaultdict

METRICS = ['claimCoverage', 'contextCoverage', 'factualErrors', 'unsupportedClaims', 'evidenceGaps']
ALL_ARMS = ['graph', 'relational', 'hybrid', 'candidate', 'shape-r']
PAIRS = [('graph', 'relational'), ('hybrid', 'relational'), ('hybrid', 'graph'), ('candidate', 'shape-r')]


def artifacts(exp):
    """(model, replicate, case, system) -> artifact meta."""
    out = {}
    for f in glob.glob(f'{exp}/**/artifacts/*/*.json', recursive=True):
        parts = f[len(exp) + 1:].split('/')
        rep = int(parts[0].split('-')[1]) if parts[0].startswith('replicate-') else 1
        model = parts[1] if rep > 1 else parts[0]
        case, system = parts[-2], parts[-1][:-5]
        try:
            meta = json.load(open(f))['meta']
        except Exception:
            continue
        out[(model, rep, case, system)] = meta
    return out


def verdicts(exp):
    """(model, replicate, case) -> consensus score for the candidate vs base: +1, 0, -1."""
    per = defaultdict(lambda: defaultdict(dict))
    for f in glob.glob(f'{exp}/**/judgments/v*/*/*/*.json', recursive=True):
        parts = f[len(exp) + 1:].split('/')
        rep = int(parts[0].split('-')[1]) if parts[0].startswith('replicate-') else 1
        model = parts[1] if rep > 1 else parts[0]
        try:
            d = json.load(open(f))
        except Exception:
            continue
        pref = d['judgment'].get('preferred')
        winner = d['labels'].get(pref) if pref in ('A', 'B') else None
        per[(model, rep, d['case'])][d['judge']][d['order']] = winner
    out = {}
    for key, judges in per.items():
        scores = []
        for orders in judges.values():
            w = set(orders.values())
            scores.append(1 if w == {'tracetoon-candidate'} else -1 if w == {'tracetoon-baseline'} else 0)
        out[key] = scores[0] if scores and len(set(scores)) == 1 else 0
    return out


def judge_cost(exp):
    return sum(json.load(open(f)).get('costUsd') or 0 for f in glob.glob(f'{exp}/**/judgments/v*/*/*/*.json', recursive=True))


def quality(exp):
    """model -> system -> metric -> mean over replicates (from the summary reports)."""
    s = json.load(open(f'{exp}/summary.json'))
    out = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for r in s['reports']:
        for sy in r['report']['splits']['dev']['systems']:
            for k in METRICS:
                if isinstance(sy.get(k), (int, float)):
                    out[r['model']][sy['system']][k].append(sy[k])
    return {m: {sy: {k: st.mean(v) for k, v in ks.items()} for sy, ks in d.items()} for m, d in out.items()}


def med(xs):
    xs = [x for x in xs if x is not None]
    return st.median(xs) if xs else None


def tot(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) if xs else None


def fmt(x, nd=0):
    if x is None:
        return '—'
    return f'{x:,.{nd}f}'


def paired(verd, x, y, model):
    better = worse = same = 0
    for k, v in verd[x].items():
        if k[0] != model or k not in verd[y]:
            continue
        d = v - verd[y][k]
        better += d > 0
        worse += d < 0
        same += d == 0
    return better, worse, same


def main():
    trio = sys.argv[1]
    md_out = sys.argv[sys.argv.index('--md') + 1] if '--md' in sys.argv else None
    lines = ['# Graph, relational and hybrid vs base (paired prbench arms)', '']
    checks = []
    shape_rows = []
    shape_full = []
    for provider in ['claude', 'codex']:
        arms = [a for a in ALL_ARMS if os.path.exists(f'{trio}/{provider}-{a}/summary.json')]
        if 'graph' not in arms or len(arms) < 2:
            lines += [f'## {provider}: not complete', '']
            continue
        exps = {arm: f'{trio}/{provider}-{arm}' for arm in arms}
        arts = {arm: artifacts(e) for arm, e in exps.items()}
        verd = {arm: verdicts(e) for arm, e in exps.items()}
        qual = {arm: quality(e) for arm, e in exps.items()}
        # Shared base check: the same base artifact in every experiment.
        base_keys = [k for k in arts['graph'] if k[3] == 'tracetoon-baseline']
        shared = ', '.join(
            f"{arm} {sum(1 for k in base_keys if arts[arm].get(k, {}).get('startedAt') == arts['graph'][k].get('startedAt'))}/{len(base_keys)}"
            for arm in arms if arm != 'graph')
        lines += [f'## {provider}', '', f'Shared base with the graph experiment: {shared}. '
                  'Judging (evaluation overhead, not an arm cost): '
                  + ', '.join(f'{arm} ${judge_cost(e):.2f}' for arm, e in exps.items()) + '.', '']
        models = sorted({k[0] for k in arts['graph']})
        for model in models:
            lines += [f'### {model}', '',
                      '| arm | W-L-T vs base | claim cov | context cov | factual err | unsupported | evidence gaps | writer $ (total) | input tok (median) | cached in (median) | output tok (median) | writer s (median) | lookups (median) | engine ms (median) | wasm MB/load |',
                      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
            rows = {}
            for arm in ['base'] + arms:
                src = 'graph' if arm == 'base' else arm
                system = 'tracetoon-baseline' if arm == 'base' else 'tracetoon-candidate'
                metas = [m for k, m in arts[src].items() if k[0] == model and k[3] == system]
                q = qual[src].get(model, {}).get(system, {})
                if arm == 'base':
                    wlt = '—'
                else:
                    sc = [v for k, v in verd[arm].items() if k[0] == model]
                    wlt = f'{sc.count(1)}-{sc.count(-1)}-{sc.count(0)}'
                oc = lambda name: [m.get('operationCounts', {}).get(name) for m in metas]
                loads = oc('evidence.loads')
                eng = [((a or 0) + (b or 0)) if (a is not None or b is not None) else None for a, b in zip(oc('evidence.loadMs'), oc('evidence.queryMs'))]
                wasm = [w / l / 1024 if w and l else None for w, l in zip(oc('evidence.wasmKB'), loads)]
                r = {
                    'cost': tot([m.get('costUsd') for m in metas]),
                    'in': med([m.get('inputTokens') for m in metas]),
                    'cached': med([m.get('cachedInputTokens') for m in metas]),
                    'out': med([m.get('outputTokens') for m in metas]),
                    'secs': med([(m.get('stageTimings') or {}).get('writerMs', 0) / 1000 or None for m in metas]),
                    'lookups': med(oc('graph.queries')),
                    'eng': med(eng),
                    'wasm': med(wasm),
                    'q': q,
                    'n': len(metas),
                }
                rows[arm] = r
                lines.append(
                    f"| {arm} (n={r['n']}) | {wlt} | " + ' | '.join(fmt(q.get(k), 3) for k in METRICS)
                    + f" | {fmt(r['cost'], 2) if r['cost'] is not None else 'not reported'} | {fmt(r['in'])} | {fmt(r['cached'])} | {fmt(r['out'])} | {fmt(r['secs'], 1)} | {fmt(r['lookups'])} | {fmt(r['eng'], 1)} | {fmt(r['wasm'], 1)} |")
            lines.append('')
            pair_res = {}
            for x, y in PAIRS:
                if x in arms and y in arms:
                    b, w, e = paired(verd, x, y, model)
                    pair_res[(x, y)] = (b, w)
                    lines.append(f'Paired on the same base sample: {x} better than {y} in {b} cases, worse in {w}, equal in {e}.')
            lines.append('')
            if ('candidate', 'shape-r') in pair_res:
                b, w = pair_res[('candidate', 'shape-r')]
                shape_rows.append((provider, model, b, w))
                shape_full.append((provider, model, b, w, rows['candidate']['q'].get('factualErrors'), rows['shape-r']['q'].get('factualErrors')))
            for arm in [a for a in ('graph', 'hybrid') if a in arms and 'relational' in arms]:
                g, rl = rows[arm], rows['relational']
                if g['in'] and rl['in']:
                    b, w = pair_res[(arm, 'relational')]
                    checks.append((provider, model, arm, 1 - g['in'] / rl['in'], b, w, g['q'].get('factualErrors'), rl['q'].get('factualErrors'),
                                   pair_res.get(('hybrid', 'graph')) if arm == 'hybrid' else None))
    lines += ['## Outcome A checks (fixed in advance)', '',
              'graph (first attempt): A holds where graph is not worse than relational on paired verdicts, has no more factual errors, and uses at least 15% fewer median input tokens; or is clearly better at equal cost.',
              'hybrid (second attempt): A holds where hybrid is not worse than relational on paired verdicts (better ≥ worse), has no more factual errors, and uses at least 15% fewer median input tokens. Second criterion: hybrid beats graph on paired verdicts.', '',
              '| provider | model | arm | input-token saving vs relational | paired vs relational (better/worse) | factual err arm/relational | A | hybrid vs graph (better/worse) |',
              '|---|---|---|---|---|---|---|---|']
    for p, m, arm, s, b, w, fa, fr, hg in checks:
        notworse = b >= w and (fa or 0) <= (fr or 0) + 1e-9
        holds = (notworse and s >= 0.15) or (arm == 'graph' and b > w and abs(s) < 0.15)
        hgs = f'{hg[0]}/{hg[1]} ({"beats" if hg[0] > hg[1] else "does not beat"})' if hg else '—'
        lines.append(f'| {p} | {m} | {arm} | {s:+.0%} | {b}/{w} | {fmt(fa, 3)}/{fmt(fr, 3)} | {"yes" if holds else "no"} | {hgs} |')
    shape = [(p, m, b, w) for p, m, b, w in shape_rows]
    if shape:
        lines += ['', '## Shape test, measure 2 (end to end): G = candidate (graph-shaped), R = shape-r (relational/vector)', '',
                  'H1 needs G preferred over R in more same-base pairs than the reverse on both providers, with factual errors no higher.', '',
                  '| provider | model | G better / R better (same base sample) | factual err G / R |', '|---|---|---|---|']
        for p, m, b, w, fg, fr in shape_full:
            lines.append(f'| {p} | {m} | {b} / {w} | {fmt(fg, 3)} / {fmt(fr, 3)} |')
        for p in sorted({x[0] for x in shape_full}):
            pb = sum(x[2] for x in shape_full if x[0] == p); pw = sum(x[3] for x in shape_full if x[0] == p)
            lines.append(f'\n**{p} total:** G better in {pb}, R better in {pw}.')
    text = '\n'.join(lines) + '\n'
    print(text)
    if md_out:
        open(md_out, 'w').write(text)


if __name__ == '__main__':
    main()
