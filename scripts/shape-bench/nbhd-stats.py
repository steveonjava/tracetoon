import re,sys
D=sys.argv[1]; tot=[0,0]
for c in ['pr10','pr11','pr12','pr5','pr8','pr9','vexaim']:
    t=open(f'{D}/{c}.nb.txt').read()
    a=t.index('Evidence by change'); m=re.search(r'\n(tests|housekeeping|validation)\[\d+\]\{',t[a:])
    ev=t[a:a+m.start()] if m else t[a:]
    code=sum(1 for l in ev.splitlines() if re.match(r'\s{4}H\d+  |\s{8,}[-+] ',l))
    sent=re.findall(r'^\s+\[\w{12}#\d+\].*$',ev,re.M); linked=sum(1 for s in sent if '→ H' in s or 'implementedBy' in s)
    tot[0]+=linked; tot[1]+=len(sent)
    print(f'{c:7} total {len(t)//4:5} evidence {len(ev)//4:5} code lines {code:3} sentences linked {linked}/{len(sent)}')
print('sentences linked', tot)
