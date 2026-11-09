#!/usr/bin/env python3
"""Token test (H2) report: GN vs R per provider, quality and cost, with the preregistered verdict.

usage: h2-report.py <trio dir> [--gn gn2] [--r r2] [--md out.md] [--json out.json]
Quality: same-base consensus pairs (arm-report.py's verdicts) and mean factual errors.
Cost: USD per accepted draft from token-phases.py (writer + subagents), paired GN/R on
(model, replicate, case); median ratio and a 95% case-clustered bootstrap interval.
"""
import importlib.util, json, os, random, statistics as st, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
AR = load('arm_report', 'arm-report.py')
TP = load('token_phases', 'token-phases.py')

args = sys.argv[1:]
opt = lambda n, d=None: args[args.index(n) + 1] if n in args else d
trio = args[0]
GN, RR = opt('--gn', 'gn2'), opt('--r', 'r2')
MODELS = {'claude': ['claude-haiku-5-5@low', 'claude-sonnet-5-5@medium'], 'codex': ['gpt-6-luna@low', 'gpt-6.1-terra@medium']}

def boot_ratio(pairs, seed=7, n=10000):
    """pairs: list of (case, ratio). Median ratio and 95% CI, resampling cases then pairs."""
    by = defaultdict(list)
    for c, r in pairs: by[c].append(r)
    cases = sorted(by)
    rnd = random.Random(seed); meds = []
    for _ in range(n):
        xs = []
        for c in (rnd.choice(cases) for _ in cases):
            xs += [rnd.choice(by[c]) for _ in by[c]]
        meds.append(st.median(xs))
    meds.sort()
    return st.median([r for _, r in pairs]), meds[int(0.025 * n)], meds[int(0.975 * n) - 1]

out = ['# Token test (H2): GN vs R', '', f'GN = `{GN}` legs, R = `{RR}` legs. See PREREGISTRATION.md for the rule.', '']
verdict = {}
summary = {}
for prov, models in MODELS.items():
    gexp, rexp = f'{trio}/{prov}-{GN}', f'{trio}/{prov}-{RR}'
    if not (os.path.isdir(gexp) and os.path.isdir(rexp)): continue
    # Quality
    verd = {GN: AR.verdicts(gexp), RR: AR.verdicts(rexp)}
    try: qual = {GN: AR.quality(gexp), RR: AR.quality(rexp)}
    except Exception: qual = {GN: {}, RR: {}}
    better = worse = same = 0
    ferr = {GN: [], RR: []}
    for m in models:
        b, w, s = AR.paired(verd, GN, RR, m); better += b; worse += w; same += s
        for a in (GN, RR):
            fe = qual[a].get(m, {}).get('tracetoon-candidate', {}).get('factualErrors')
            if fe is not None: ferr[a].append(fe)
    fe_g = st.mean(ferr[GN]) if ferr[GN] else None; fe_r = st.mean(ferr[RR]) if ferr[RR] else None
    q_pass = better > worse and (fe_g is not None and fe_r is not None and fe_g <= fe_r)
    # Cost
    rows = {a: [r for r in TP.run([e], 'tracetoon-candidate') if r['accepted']] for a, e in ((GN, gexp), (RR, rexp))}
    allrows = {a: TP.run([e], 'tracetoon-candidate') for a, e in ((GN, gexp), (RR, rexp))}
    key = lambda r: (r['modelKey'], r['replicate'], r['case'])
    gi = {key(r): r for r in rows[GN]}; ri = {key(r): r for r in rows[RR]}
    pairs = [(k[2], gi[k]['usd'] / ri[k]['usd']) for k in gi if k in ri and gi[k]['usd'] and ri[k]['usd']]
    med_r, lo, hi = boot_ratio(pairs) if len(pairs) >= 3 else (None, None, None)
    c_pass = med_r is not None and med_r <= 0.80 and hi < 1.0
    refuted = worse > better or (med_r is not None and med_r >= 1.0)
    verdict[prov] = 'pass' if (q_pass and c_pass) else 'refuted' if refuted else 'inconclusive'
    summary[prov] = dict(better=better, worse=worse, same=same, fe_gn=fe_g, fe_r=fe_r, pairs=len(pairs), median_ratio=med_r, ci=[lo, hi], q_pass=q_pass, c_pass=c_pass)
    md = lambda xs: st.median(xs) if xs else float('nan')
    out += [f'## {prov}', '',
            f"- **Quality:** GN preferred in {better} same-base pairs, R in {worse}, equal {same}. Mean factual errors per draft: GN {fe_g if fe_g is None else f'{fe_g:.3f}'}, R {fe_r if fe_r is None else f'{fe_r:.3f}'}. **{'pass' if q_pass else 'fail'}**.",
            f"- **Cost:** {len(pairs)} matched pairs; median GN/R USD ratio {'—' if med_r is None else f'{med_r:.3f}'}, 95% CI [{'—' if lo is None else f'{lo:.3f}'}, {'—' if hi is None else f'{hi:.3f}'}]. **{'pass' if c_pass else 'fail'}** (needs ≤ 0.80 and upper bound < 1.0).",
            '', '| model | arm | drafts | median USD | total USD (accepted) | total USD (all attempts) | median tokens in | median turns | median seconds | reviewer share | render share | evidence share |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for m in models:
        for a in (GN, RR):
            rs = [r for r in rows[a] if r['modelKey'] == m]
            al = [r for r in allrows[a] if (r['model'] or '') and m.startswith(r['model'] + '@')]
            if not rs: continue
            tin = [r['tokens'].get('input', 0) + r['tokens'].get('write', 0) + r['tokens'].get('read', 0) for r in rs]
            sh = lambda p: st.mean(r['shares'][p] for r in rs)
            out.append(f"| {m} | {a} | {len(rs)} | {md([r['usd'] for r in rs]):.4f} | {sum(r['usd'] or 0 for r in rs):.3f} | {sum(r['usd'] or 0 for r in al):.3f} | {md(tin):,.0f} | {md([r['turns'] for r in rs])} | {md([r['seconds'] for r in rs])} | {sh('reviewer'):.0%} | {sh('render'):.0%} | {sh('evidence'):.0%} |")
    out.append('')
v = verdict.values()
overall = 'H2 SUPPORTED' if verdict and all(x == 'pass' for x in v) and len(verdict) == 2 else 'H2 REFUTED' if any(x == 'refuted' for x in v) else 'H2 INCONCLUSIVE'
out += ['## Verdict', '', *(f'- {p}: {x}' for p, x in verdict.items()), '', f'**{overall}** (per the preregistered rule).', '']
text = '\n'.join(out) + '\n'; print(text)
if opt('--md'): open(opt('--md'), 'w').write(text)
if opt('--json'): json.dump(dict(summary=summary, verdict=verdict, overall=overall), open(opt('--json'), 'w'), indent=1)
