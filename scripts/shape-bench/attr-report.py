import json,sys,re
from collections import Counter
D=sys.argv[1]; cases=['pr10','pr11','pr12','pr5','pr8','pr9','vexaim']
tot=Counter(); combo=Counter(); also=0
print('| case | edit links | commit links | search links | search links also joined | search: bm25+vec | +mention | vec alone | bm25 alone | mention only |')
print('|---|---|---|---|---|---|---|---|---|---|')
for c in cases:
    a=json.load(open(f'{D}/{c}.attr.json')); L={r['kind']:r['n'] for r in a['links']}
    cb=Counter({(r['combo'] or 'none'):r['n'] for r in a['searchByRankers']})
    for k,v in L.items(): tot[k]+=v
    combo+=cb; also+=a['searchAlsoJoined'][0]['n']
    g=lambda *ks: sum(v for k,v in cb.items() if set(k.split('+'))==set(ks))
    withm=sum(v for k,v in cb.items() if 'mention' in k and k!='mention')
    print(f"| {c} | {L.get('edit',0)} | {L.get('commit',0)} | {L.get('search',0)} | {a['searchAlsoJoined'][0]['n']} | {g('bm25','vec')} | {withm} | {g('vec')} | {g('bm25')} | {g('mention')} |")
print('\ntotals', dict(tot), 'search also joined', also); print('ranker combos', combo.most_common())
def lines(t): return [l for l in t.splitlines() if l.strip()]
print('\n| case | ablation | context lines kept vs full | refs kept | "→"/"why" link lines (full → ablated) | tokens |')
print('|---|---|---|---|---|---|')
for c in cases:
    f=open(f'{D}/{c}.full.txt').read(); fl=lines(f); fr=set(re.findall(r'^\s*\[([^\]]+)\]',f,re.M))
    nl=lambda t: len(re.findall(r'→|why ',t))
    for ab in ['novec','nosearch','nojoins','nolinks']:
        t=open(f'{D}/{c}.{ab}.txt').read(); tl=Counter(lines(t)); kept=sum(min(n,tl[l]) for l,n in Counter(fl).items())
        tr=set(re.findall(r'^\s*\[([^\]]+)\]',t,re.M))
        print(f'| {c} | {ab} | {kept/len(fl):.0%} | {len(fr&tr)}/{len(fr)} | {nl(f)} → {nl(t)} | {len(t)//4} |')
