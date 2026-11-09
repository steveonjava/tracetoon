#!/usr/bin/env python3
"""Token cost of each writer draft, and where it went.

usage: token-phases.py <experiment dir>... [--system tracetoon-candidate] [--json out.json] [--md out.md]

For every writer attempt (`attempts/writer/<key>/<n>/<case>/<system>.traces/*.jsonl`):
- totals over the writer and all subagent traces: uncached input, cache writes,
  cache reads, output, turns, wall time;
- USD: Claude's reported costUsd (artifact meta, run total). Codex: token counts
  at prbench's list prices (src/report/prices.json, as `estimateCost` does);
- phases: each turn's cost split over what is in the context at that turn
  (a tool result costs its size at every later turn that re-reads it), and each
  turn's output to the tool call it makes. Phases: setup (system prompt, skill
  docs), evidence (prepare, brief, query, digest, status), raw reading (patch,
  repo files), checks (tracetoon check runs), render (render/publish and their
  findings), drafting (writing title/body/change map), reviewer (subagent traces
  and messages to them), waits/other.

Relative prices used to split a turn's cost: cache read 0.1x input, cache write
2x (Claude 1-hour cache), output 5x; Codex uses the listed prices. Claude phase
shares are scaled to the reported costUsd.
"""
import glob, json, os, re, statistics as st, sys
from collections import Counter, defaultdict

H = '/home/steve/.claude/jobs/d955bb9a/tmp/harness'
PRICES = json.load(open(f'{H}/src/report/prices.json'))['models']
PHASES = ['setup', 'evidence', 'raw reading', 'checks', 'render', 'drafting', 'reviewer', 'other']

TT = r'(?:tracetoon\S*|\$T\b|"\$T"|\$\{T\}|\$TRACETOON_BIN|\$BIN)\s+'
DOCS = r'SKILL\.md|(?:contribution-workflow|writing-guide|quick-path|drafting|reviewer-brief|comic-guide)\.md|/references/'

def cat_command(cmd: str) -> str:
    c = cmd
    if re.search(TT + r'(render|publish|preview)\b', c): return 'render'
    if re.search(TT + r'check\b', c) or 'write_stdin' in c: return 'checks'
    if re.search(TT + r'(prepare|query|digest|status|doctor|task|expand|context|outline|review)\b', c): return 'evidence'
    if re.search(r'(title\.txt|body\.md|change-map\.json)', c) and re.search(r'cat\s*>|>\s*\S*(title|body|change-map)|\btee\b|apply_patch|python3|sed -i|perl -pi', c):
        return 'drafting'
    if re.search(DOCS, c): return 'setup'
    if re.search(r'evidence-notes\.md|digest(-full)?\.json|checks\.json|submission\.json|context\.json|brief|review-input\.json', c): return 'evidence'
    if re.search(r'\b(git\s+(diff|show|log)|cat|sed|rg|grep|head|tail|nl|awk|find|ls|wc)\b|changes\.patch', c): return 'raw reading'
    if re.search(r'\bsleep\b', c): return 'other'
    return 'other'


def cat_claude_tool(b: dict) -> str:
    name = b.get('name', '')
    inp = b.get('input') or {}
    if name == 'Skill': return 'setup'
    if name in ('Agent', 'Task', 'SendMessage'): return 'reviewer'
    if name in ('Write', 'Edit', 'MultiEdit'):
        p = str(inp.get('file_path', ''))
        return 'drafting' if re.search(r'title\.txt|body\.md|change-map\.json', p) else 'other'
    if name == 'Read':
        p = str(inp.get('file_path', ''))
        if re.search(r'SKILL\.md|/references/', p): return 'setup'
        if re.search(r'evidence-notes|/runs/', p): return 'evidence'
        return 'raw reading'
    if name in ('Grep', 'Glob'): return 'raw reading'
    if name == 'Bash': return cat_command(str(inp.get('command', '')))
    return 'other'

def est(text) -> int:
    return max(1, len(text if isinstance(text, str) else json.dumps(text)) // 4)

class Turns:
    """Context segments and per-turn usage for one trace, attributed to phases."""
    def __init__(self, ratios):
        self.r = ratios  # dict: input, write, read, output -> relative price
        self.segs = []   # [phase, tokens, new?]
        self.cost = Counter()
        self.first = True
    def add(self, phase, tokens):
        self.segs.append([phase, tokens, True])
    def turn(self, inp, write, read, out, out_phase):
        total_in = inp + write + read
        if self.first:
            known = sum(x[1] for x in self.segs)
            self.segs.insert(0, ['setup', max(0, total_in - known), True])
            self.first = False
        new = [x for x in self.segs if x[2]]
        old = [x for x in self.segs if not x[2]]
        ns, os_ = sum(x[1] for x in new), sum(x[1] for x in old)
        fresh = inp * self.r['input'] + write * self.r['write']
        reread = read * self.r['read']
        # Fresh input (uncached, cache writes) is what was added since the last
        # turn; cache reads are the older context. Fall back to all segments.
        for group, units, size in ((new, fresh, ns), (old, reread, os_)):
            if not size:
                group, size = self.segs, ns + os_
            for x in group:
                self.cost[x[0]] += units * x[1] / (size or 1)
        for x in self.segs:
            x[2] = False
        self.cost[out_phase] += out * self.r['output']
        self.segs.append([out_phase, out, True])


def claude_trace(path, ratios, sub):
    """One turn per assistant message id (Claude logs each content block as its own entry)."""
    t = Turns(ratios); tok = Counter(); turns = 0
    events = []  # ('turn', usage, [blocks]) or ('user', content)
    index = {}
    for l in open(path):
        try: e = json.loads(l)
        except Exception: continue
        m = e.get('message') or {}
        if e.get('type') == 'assistant' and isinstance(m.get('content'), list):
            mid = m.get('id') or id(m)
            if mid in index:
                ev = events[index[mid]]
                ev[2].extend(m['content'])
                if m.get('usage'): ev[1] = m['usage']
            else:
                index[mid] = len(events)
                events.append(['turn', m.get('usage') or {}, list(m['content'])])
        elif e.get('type') == 'user' and isinstance(m.get('content'), list):
            events.append(['user', m['content'], None])
    last_phase = 'other'
    for ev in events:
        if ev[0] == 'turn':
            u, blocks = ev[1], ev[2]
            phase = 'reviewer' if sub else 'other'
            if not sub:
                for b in blocks:
                    if b.get('type') == 'tool_use':
                        phase = cat_claude_tool(b)
            i, w, r, o = u.get('input_tokens', 0), u.get('cache_creation_input_tokens', 0), u.get('cache_read_input_tokens', 0), u.get('output_tokens', 0)
            if i + w + r + o == 0: continue
            t.turn(i, w, r, o, phase); turns += 1
            tok.update(input=i, write=w, read=r, output=o)
            last_phase = phase
        else:
            for b in ev[1]:
                if b.get('type') == 'tool_result':
                    t.add('reviewer' if sub else last_phase, est(b.get('content', '')))
                elif b.get('type') == 'text':
                    t.add('setup' if turns == 0 else ('reviewer' if sub else 'other'), est(b.get('text', '')))
    c = Counter({'reviewer': sum(t.cost.values())}) if sub else t.cost
    return c, tok, turns

def codex_trace(path, ratios, sub):
    t = Turns(ratios); tok = Counter(); turns = 0; phase = 'other'; last_total = None
    for l in open(path):
        try: e = json.loads(l)
        except Exception: continue
        p = e.get('payload') or {}
        ty = p.get('type')
        if ty in ('function_call', 'custom_tool_call'):
            a = str(p.get('arguments') or p.get('input') or '')
            name = p.get('name') or ''
            if sub: phase = 'reviewer'
            elif name in ('followup_task', 'spawn_agent', 'send_input', 'wait', 'wait_agent') or a.lstrip().startswith('{"target"'): phase = 'reviewer'
            else: phase = cat_command(a)
        elif ty in ('function_call_output', 'custom_tool_call_output'):
            t.add('reviewer' if sub else phase, est(str(p.get('output', ''))))
        elif ty == 'token_count' and p.get('info'):
            u = p['info'].get('last_token_usage') or {}
            last_total = p['info'].get('total_token_usage') or last_total
            inp_all, cached, out = u.get('input_tokens', 0), u.get('cached_input_tokens', 0), u.get('output_tokens', 0)
            if inp_all + out == 0: continue
            t.turn(inp_all - cached, 0, cached, out, 'reviewer' if sub else phase); turns += 1
    if last_total:
        tok.update(input=last_total.get('input_tokens', 0) - last_total.get('cached_input_tokens', 0),
                   read=last_total.get('cached_input_tokens', 0), output=last_total.get('output_tokens', 0))
    c = Counter({'reviewer': sum(t.cost.values())}) if sub else t.cost
    return c, tok, turns

def is_codex(path):
    with open(path) as f:
        for l in f:
            return '"payload"' in l
    return False

def main_trace(d, files):
    idx = os.path.join(d, 'index.json')
    subs = set()
    if os.path.exists(idx):
        for en in json.load(open(idx)).get('entries', []):
            if '/subagents/' in en.get('source', ''): subs.add(en['file'])
    if subs: return [f for f in files if os.path.basename(f) not in subs], [f for f in files if os.path.basename(f) in subs]
    # Codex: the writer's trace starts first.
    def start(f):
        with open(f) as h:
            for l in h:
                try: return json.loads(l).get('timestamp', '')
                except Exception: return ''
        return ''
    files = sorted(files, key=start)
    return files[:1], files[1:]

def draft(d, system):
    files = glob.glob(d + '/*.jsonl')
    if not files: return None
    mains, subs = main_trace(d, files)
    art = d.replace('.traces', '.json'); status = d.replace('.traces', '.status.json')
    meta = json.load(open(art)).get('meta', {}) if os.path.exists(art) else {}
    stj = json.load(open(status)) if os.path.exists(status) else {}
    codex = is_codex(files[0])
    model = meta.get('model')
    if codex:
        pr = PRICES.get(model or '', {'input': 1, 'cachedInput': 0.1, 'output': 5})
        ratios = {'input': pr['input'] / 1e6, 'write': pr['input'] / 1e6, 'read': pr['cachedInput'] / 1e6, 'output': pr['output'] / 1e6}
    else:
        ratios = {'input': 1, 'write': 2, 'read': 0.1, 'output': 5}
    cost = Counter(); tok = Counter(); turns = 0
    for f in mains + subs:
        c, k, n = (codex_trace if codex else claude_trace)(f, ratios, f in subs)
        cost += c; tok += k; turns += n
    units = sum(cost.values()) or 1
    if codex:
        usd = units  # ratios are USD per token
    else:
        usd = meta.get('costUsd')
    shares = {p: cost[p] / units for p in PHASES}
    w = stj.get('writer') or {}
    parts = d.split('/')
    return dict(attempt='/'.join(parts[-4:-1]), case=parts[-2], system=system, model=model,
                effort=meta.get('reasoningEffort'), ok=os.path.exists(art) and w.get('exitCode') == 0 and not w.get('isError'),
                usd=usd, tokens=dict(tok), turns=turns, files=len(files),
                seconds=round((stj.get('stageTimings') or {}).get('totalMs', 0) / 1000), shares=shares,
                body=(json.load(open(art)).get('body') if os.path.exists(art) else None))

def accepted_map(exp, system):
    """(model@effort, replicate, case) -> artifact body, for matching attempts to accepted drafts."""
    out = {}
    for f in glob.glob(f'{exp}/**/artifacts/*/{system}.json', recursive=True):
        rel = f[len(exp) + 1:].split('/')
        rep = int(rel[0].split('-')[1]) if rel[0].startswith('replicate-') else 1
        model = rel[1] if rep > 1 else rel[0]
        out[(model, rep, rel[-2])] = json.load(open(f)).get('body')
    return out

def run(exps, system):
    rows = []
    for exp in exps:
        acc = accepted_map(exp, system)
        by_body = {v: k for k, v in acc.items() if v}
        for d in sorted(glob.glob(f'{exp}/attempts/writer/*/*/*/{system}.traces')):
            r = draft(d, system)
            if not r: continue
            r['exp'] = exp.rstrip('/').split('/')[-1]
            key = by_body.get(r.pop('body'))
            r['accepted'] = key is not None
            if key: r['modelKey'], r['replicate'] = key[0], key[1]
            rows.append(r)
    return rows

if __name__ == '__main__':
    args = sys.argv[1:]
    opt = lambda n: args[args.index(n) + 1] if n in args else None
    system = opt('--system') or 'tracetoon-candidate'
    skip = {opt('--system'), opt('--json'), opt('--md')}
    exps = [a for a in args if not a.startswith('--') and a not in skip]
    rows = run(exps, system)
    if opt('--json'): json.dump(rows, open(opt('--json'), 'w'), indent=1)
    L = ['# Writer cost per draft and where it went', '',
         'Accepted drafts (matched to the experiment\'s artifacts). USD: Claude reported costUsd; Codex tokens at prbench list prices. Phase shares are of each draft\'s cost, then averaged.', '']
    groups = defaultdict(list)
    for r in rows:
        if r['accepted']: groups[(r['exp'], r['modelKey'])].append(r)
    L += ['| experiment | model | drafts | median USD | median input tok (uncached+write+read) | median output | median turns | ' + ' | '.join(PHASES) + ' |',
          '|---|---|---|---|---|---|---|' + '---|' * len(PHASES)]
    for (exp, model), rs in sorted(groups.items()):
        md = lambda xs: st.median(xs) if xs else float('nan')
        usd = [r['usd'] for r in rs if r['usd'] is not None]
        tin = [r['tokens'].get('input', 0) + r['tokens'].get('write', 0) + r['tokens'].get('read', 0) for r in rs]
        sh = {p: st.mean(r['shares'][p] for r in rs) for p in PHASES}
        L.append(f"| {exp} | {model} | {len(rs)} | {md(usd):.4f} | {md(tin):,.0f} | {md([r['tokens'].get('output', 0) for r in rs]):,.0f} | {md([r['turns'] for r in rs])} | " + ' | '.join(f"{sh[p]:.0%}" for p in PHASES) + ' |')
    allr = defaultdict(list)
    for r in rows: allr[(r['exp'], r['model'])].append(r)
    L += ['', 'All attempts (including failed and killed ones):', '']
    for (exp, model), rs in sorted(allr.items(), key=lambda x: (x[0][0], str(x[0][1]))):
        usd = [r['usd'] or 0 for r in rs]
        L.append(f"- {exp} / {model}: {len(rs)} attempts, total USD {sum(usd):.3f}, accepted {sum(r['accepted'] for r in rs)}")
    text = '\n'.join(L) + '\n'
    print(text)
    if opt('--md'): open(opt('--md'), 'w').write(text)
