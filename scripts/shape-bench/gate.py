"""Summarize a prbench --plan JSON (stdin): reuse per system. Exit 0 when every
tracetoon-baseline job is a cache hit and there are 30 of them."""
import json, sys, collections

text = sys.stdin.read()
plan = json.loads(text[text.index('{'):])
c = collections.Counter((j['system'], j['reuse']) for j in plan['jobs'])
print(json.dumps({f'{s}:{"hit" if r else "miss"}': n for (s, r), n in sorted(c.items())}))
base_hits = c[('tracetoon-baseline', True)]
base_miss = c[('tracetoon-baseline', False)]
sys.exit(0 if base_hits == 30 and base_miss == 0 else 1)
