#!/usr/bin/env python3
"""Brief-guide round verdict per model: candidate leg vs control leg on the same base.
usage: guide-report.py <control exp> <candidate exp> [label]"""
import json,sys,importlib.util,statistics as st,random,os
H=os.path.dirname(os.path.abspath(__file__))
spec=importlib.util.spec_from_file_location('ar',f'{H}/arm-report.py'); ar=importlib.util.module_from_spec(spec); spec.loader.exec_module(ar)
ce,ge=sys.argv[1],sys.argv[2]; label=sys.argv[3] if len(sys.argv)>3 else ''
def scores(exp):
    s=json.load(open(f'{exp}/summary.json'))
    return {(d['model'],d['replicate'],d['case']):d for d in s['scores'] if d['system']=='tracetoon-candidate'}, {(d['model'],d['replicate'],d['case']):d for d in s['scores'] if d['system']=='tracetoon-baseline'}
sc,bc=scores(ce); sg,bg=scores(ge)
keys=sorted(k for k in sg if k in sc)
same_base=sum(1 for k in keys if bc.get(k,{}).get('composite')==bg.get(k,{}).get('composite'))
vc,vg=ar.verdicts(ce),ar.verdicts(ge)
vk=[k for k in vg if k in vc]
b=sum(vg[k]>vc[k] for k in vk); w=sum(vg[k]<vc[k] for k in vk)
diff=[sg[k]['composite']-sc[k]['composite'] for k in keys]
rnd=random.Random(7); cases=sorted({k[2] for k in keys}); byc={c:[sg[k]['composite']-sc[k]['composite'] for k in keys if k[2]==c] for c in cases}
boots=sorted(st.mean([x for c in (rnd.choice(cases) for _ in cases) for x in byc[c]]) for _ in range(10000))
m=lambda D,f: st.mean(D[k][f] for k in keys)
fe_c,fe_g=m(sc,'factualErrors'),m(sg,'factualErrors')
p1=b>w; p2=st.mean(diff)>0; p3=fe_g<=fe_c
print(f'## {label}'); print()
print(f'- Paired samples: {len(keys)} (base composite identical in {same_base}); verdict pairs judged: {len(vk)}')
print(f'- Preference vs control (same base): guide better {b}, control better {w}, equal {len(vk)-b-w} -> {"pass" if p1 else "fail"}')
print(f'- Composite: control {m(sc,"composite"):.1f}, guide {m(sg,"composite"):.1f}; paired diff {st.mean(diff):+.2f} (95% case-bootstrap CI {boots[250]:+.2f} to {boots[9749]:+.2f}) -> {"pass" if p2 else "fail"}')
print(f'- Factual errors per draft: control {fe_c:.3f}, guide {fe_g:.3f} -> {"pass" if p3 else "fail"}')
for f in ['claims','context','uncertainties','rubric','unsupportedClaims','traps','costUsd']:
    print(f'  - {f}: control {m(sc,f):.3f}, guide {m(sg,f):.3f}')
print(f'- Composite vs main base: control {m(sc,"composite")-st.mean(bc[k]["composite"] for k in keys):+.1f}, guide {m(sg,"composite")-st.mean(bg[k]["composite"] for k in keys):+.1f}')
print(f'- **Model verdict: {"PASS" if p1 and p2 and p3 else ("LOSS" if w>b else "not passed")}**')
