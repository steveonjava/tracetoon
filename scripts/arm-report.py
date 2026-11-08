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
ARMS = ['graph', 'relational']


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


def main():
    trio = sys.argv[1]
    md_out = sys.argv[sys.argv.index('--md') + 1] if '--md' in sys.argv else None
    lines = ['# Graph vs relational vs base (paired prbench trio)', '']
    a_checks = []
    for provider in ['claude', 'codex']:
        exps = {arm: f'{trio}/{provider}-{arm}' for arm in ARMS}
        if not all(os.path.exists(f'{e}/summary.json') for e in exps.values()):
            lines += [f'## {provider}: not complete', '']
            continue
        arts = {arm: artifacts(e) for arm, e in exps.items()}
        verd = {arm: verdicts(e) for arm, e in exps.items()}
        qual = {arm: quality(e) for arm, e in exps.items()}
        # Shared base check: the same base artifact (body) in both experiments.
        base_keys = [k for k in arts['graph'] if k[3] == 'tracetoon-baseline']
        same = sum(1 for k in base_keys if arts['relational'].get(k, {}).get('startedAt') == arts['graph'][k].get('startedAt'))
        lines += [f'## {provider}', '', f'Shared base: {same}/{len(base_keys)} base writes identical in both experiments. '
                  f'Judging (evaluation overhead, not an arm cost): graph experiment ${judge_cost(exps["graph"]):.2f}, relational experiment ${judge_cost(exps["relational"]):.2f}.', '']
        models = sorted({k[0] for k in arts['graph']})
        for model in models:
            lines += [f'### {model}', '',
                      '| arm | W-L-T vs base | claim cov | context cov | factual err | unsupported | evidence gaps | writer $ (total) | input tok (median) | cached in (median) | output tok (median) | writer s (median) | lookups (median) | engine ms (median) | wasm MB/load |',
                      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
            rows = {}
            for arm in ['base'] + ARMS:
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
            # Paired: same base sample, graph's verdict vs relational's.
            better = worse = same_ = 0
            for k, v in verd['graph'].items():
                if k[0] != model or k not in verd['relational']:
                    continue
                d = v - verd['relational'][k]
                better += d > 0
                worse += d < 0
                same_ += d == 0
            lines += ['', f'Paired on the same base sample: graph better than relational in {better} cases, worse in {worse}, equal in {same_}.', '']
            g, rl = rows['graph'], rows['relational']
            if g['in'] and rl['in']:
                saving = 1 - g['in'] / rl['in']
                a_checks.append((provider, model, saving, better, worse, g['q'].get('claimCoverage'), rl['q'].get('claimCoverage'),
                                 g['q'].get('factualErrors'), rl['q'].get('factualErrors')))
    lines += ['## Outcome A check (fixed in advance)', '',
              'A holds where graph quality is not worse than relational (paired verdicts not worse, factual errors no higher) and graph median input tokens are at least 15% lower; or graph is clearly better at equal cost.', '',
              '| provider | model | graph input-token saving vs relational | paired better/worse | claim cov g/r | factual err g/r | A |',
              '|---|---|---|---|---|---|---|']
    for p, m, s, b, w, cg, cr, fg, fr in a_checks:
        notworse = b >= w and (fg or 0) <= (fr or 0) + 1e-9
        holds = (notworse and s >= 0.15) or (b > w and abs(s) < 0.15)
        lines.append(f'| {p} | {m} | {s:+.0%} | {b}/{w} | {fmt(cg, 3)}/{fmt(cr, 3)} | {fmt(fg, 3)}/{fmt(fr, 3)} | {"yes" if holds else "no"} |')
    text = '\n'.join(lines) + '\n'
    print(text)
    if md_out:
        open(md_out, 'w').write(text)


main()
