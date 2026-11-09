#!/usr/bin/env python3
"""Codex writer drafts: turns, tokens, time and what the turns were spent on.
usage: codex-runaway.py <experiment dir>... [--md out.md]
One row per writer attempt (writer trace plus subagent traces). Tokens are each
trace's final total_token_usage, summed; compared with the attempt artifact's meta."""
import json, glob, re, sys, os, statistics as st
from collections import Counter

def attempt_rows(exp):
    out = []
    for d in sorted(glob.glob(f'{exp}/attempts/writer/*/*/*/tracetoon-*.traces')):
        files = glob.glob(d + '/*.jsonl')
        inp = cached = outp = turns = 0
        c = Counter()
        for f in files:
            last = None; calls = {}
            for l in open(f):
                try: e = json.loads(l)
                except Exception: continue
                p = e.get('payload') or {}
                t = p.get('type')
                if t == 'token_count' and p.get('info'):
                    turns += 1; last = p['info'].get('total_token_usage') or last
                elif t in ('function_call', 'custom_tool_call'):
                    a = str(p.get('arguments') or p.get('input') or '')
                    name = p.get('name') or ''
                    calls[p.get('call_id')] = a
                    if name in ('followup_task', 'send_input', 'spawn_agent') or 'pr_review' in a[:80]: c['reviewer messages'] += 1
                    if name in ('wait', 'wait_agent') or a.strip().startswith('{"timeout_ms"') or a.strip().startswith('{"duration_ms"'): c['waits'] += 1
                    if 'write_stdin' in a: c['stdin polls'] += 1
                    for m in re.finditer(r'tracetoon\S* (render|check|prepare|digest|query|publish|review)', a): c[m.group(1)] += 1
                elif t in ('function_call_output', 'custom_tool_call_output'):
                    o = str(p.get('output', ''))
                    if '"briefCheck"' in o:
                        c['render reports'] += 1
                        if re.search(r'(untagged|unknownRefs|unbackedNames|uncovered\w*|validationClaims)\\*":\s*\[(\\n|\s)*\\*"', o): c['render reports with findings'] += 1
            if last:
                inp += last.get('input_tokens', 0); cached += last.get('cached_input_tokens', 0); outp += last.get('output_tokens', 0) + last.get('reasoning_output_tokens', 0) * 0
        art = d.replace('.traces', '.json'); status = d.replace('.traces', '.status.json')
        meta = {}
        if os.path.exists(art):
            try: meta = json.load(open(art)).get('meta') or {}
            except Exception: pass
        stj = json.load(open(status)) if os.path.exists(status) else {}
        w = stj.get('writer') or {}
        parts = d.split('/')
        out.append(dict(exp=exp.rstrip('/').split('/')[-1], key=parts[-4][:8], attempt=parts[-3], case=parts[-2],
                        files=len(files), turns=turns, input=inp, cached=cached, output=outp,
                        seconds=round((stj.get('stageTimings') or {}).get('totalMs', 0) / 1000),
                        ok=w.get('exitCode') == 0 and not w.get('isError') and os.path.exists(art),
                        metaInput=meta.get('inputTokens'), model=meta.get('model'), counts=c))
    return out

rows = [r for exp in [a for a in sys.argv[1:] if not a.startswith('--') and a != (sys.argv[sys.argv.index('--md') + 1] if '--md' in sys.argv else None)] for r in attempt_rows(exp)]
L = ['# Codex writer drafts: where the turns and tokens go', '']
for exp in sorted({r['exp'] for r in rows}):
    rs = [r for r in rows if r['exp'] == exp]
    ok = [r for r in rs if r['ok']]
    md = lambda xs: st.median(xs) if xs else 0
    L += [f'## {exp}', '',
          f"- attempts {len(rs)} (accepted-shape {len(ok)}); median input tokens {md([r['input'] for r in rs]):,.0f} (all) / {md([r['input'] for r in ok]):,.0f} (accepted); median turns {md([r['turns'] for r in rs])}; median seconds {md([r['seconds'] for r in rs])}",
          f"- per attempt, median: render {md([r['counts']['render'] for r in rs])}, render reports with findings {md([r['counts']['render reports with findings'] for r in rs])}, reviewer messages {md([r['counts']['reviewer messages'] for r in rs])}, waits {md([r['counts']['waits'] for r in rs])}, stdin polls {md([r['counts']['stdin polls'] for r in rs])}",
          '', '| case | attempt | ok | files | turns | input tokens | artifact input | seconds | render | findings | reviewer msgs | waits | polls |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for r in sorted(rs, key=lambda r: -r['input'])[:10]:
        c = r['counts']
        L.append(f"| {r['case']} | {r['key']}/{r['attempt']} | {'yes' if r['ok'] else 'no'} | {r['files']} | {r['turns']} | {r['input']:,} | {r['metaInput'] if r['metaInput'] is not None else '—'} | {r['seconds']} | {c['render']} | {c['render reports with findings']} | {c['reviewer messages']} | {c['waits']} | {c['stdin polls']} |")
    L.append('')
# trace totals vs artifact meta
both = [r for r in rows if r['metaInput']]
if both:
    diffs = [r['input'] / r['metaInput'] for r in both if r['metaInput']]
    L += ['## Trace totals vs artifact meta', '', f"- {len(both)} attempts with artifacts; trace / artifact input-token ratio: median {st.median(diffs):.3f}, min {min(diffs):.3f}, max {max(diffs):.3f}", '']
# what predicts tokens
import math
def corr(xs, ys):
    mx, my = st.mean(xs), st.mean(ys); sx = math.sqrt(sum((x - mx) ** 2 for x in xs)); sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy) if sx and sy else float('nan')
L += ['## What tracks input tokens (Pearson r over all attempts)', '']
for k in ['turns', 'render', 'render reports with findings', 'reviewer messages', 'waits', 'stdin polls']:
    xs = [r['turns'] if k == 'turns' else r['counts'][k] for r in rows]
    L.append(f"- {k}: r = {corr(xs, [r['input'] for r in rows]):.2f}")
text = '\n'.join(L) + '\n'; print(text)
if '--md' in sys.argv: open(sys.argv[sys.argv.index('--md') + 1], 'w').write(text)
