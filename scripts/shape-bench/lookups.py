import json,glob,sys,re
from collections import Counter
for leg in sys.argv[1:]:
    cmds=Counter(); refused=0; runs=0
    for idx in glob.glob(f'{leg}/**/artifacts/*/tracetoon-candidate.traces/index.json',recursive=True)+glob.glob(f'{leg}/attempts/**/tracetoon-candidate.traces/index.json',recursive=True):
        pass
    files=glob.glob(f'{leg}/attempts/writer/*/*/*/tracetoon-candidate.traces/*.jsonl')
    for f in files:
        for line in open(f):
            try: e=json.loads(line)
            except: continue
            msg=e.get('message') or {}
            for b in (msg.get('content') or []) if isinstance(msg.get('content'),list) else []:
                if b.get('type')=='tool_use' and b.get('name')=='Bash':
                    c=b['input'].get('command','')
                    for m in re.finditer(r'query\s+([a-z-]+)',c): cmds[m.group(1)]+=1
                if b.get('type')=='tool_result':
                    t=json.dumps(b.get('content'))
                    if 'no other lookups are available' in t: refused+=1
    print(leg.split('/')[-1], 'trace files',len(files), dict(cmds.most_common()), 'refusals seen', refused)
