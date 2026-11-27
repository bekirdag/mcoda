#!/usr/bin/env python3
"""Read-only near-limit, rejection and recovery checks on a live Strata server."""
import hashlib,json,pathlib,subprocess,sys,time,urllib.request,urllib.error
pid=subprocess.check_output(['systemctl','--user','show','strata-qwen-flash-next.service','-p','MainPID','--value'],text=True).strip()
command=pathlib.Path('/proc/'+pid+'/cmdline').read_bytes().decode().split('\0');cfg=json.loads(pathlib.Path(command[command.index('--profile')+1]).read_text())
sys.path.insert(0,str(pathlib.Path(cfg['cwd'])/'tools'));import strata_tokenizer as ST
p=pathlib.Path(cfg['tokenizer']);v=json.loads((p/'vocab.json').read_text());tokens=[None]*len(v)
for text,i in v.items():tokens[i]=text
tc=json.loads((p/'tokenizer.json').read_text());tok=ST.Tokenizer(tokens,(p/'merges.txt').read_text().split('\n'),json.loads((p/'token_type.json').read_text()),tc.get('pre') or 'qwen35',tc.get('special_ids') or None)
base='http://127.0.0.1:11452';health=json.load(urllib.request.urlopen(base+'/health'));ctx=health['max_context'];unit='This is an irrelevant archive record.\n';per=len(tok.encode(unit));results=[]
for name,target in [('near-limit',ctx-1024),('over-limit',ctx+1024),('recovery',0)]:
 text=('Reply only READY.\n'+unit*(target//per)+'\nEnd of archive. Reply only READY.') if target else 'Reply only READY.'
 data={'model':'qwen-latest-flash-next','messages':[{'role':'user','content':text}],'temperature':0,'max_tokens':64};started=time.monotonic();r={'case':name,'encoded_content_tokens':len(tok.encode(text)),'request_sha256':hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()}
 try:
  q=urllib.request.Request(base+'/v1/chat/completions',data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
  with urllib.request.urlopen(q,timeout=300) as response:r.update(status=response.status,response=json.load(response))
  r['correct']=name!='over-limit' and r['response']['choices'][0]['message']['content'].strip()=='READY'
 except urllib.error.HTTPError as e:r.update(status=e.code,error=e.read().decode()[:2000],correct=name=='over-limit' and e.code in [400,413,422])
 except Exception as e:r.update(error=str(e),correct=False)
 r['seconds']=time.monotonic()-started;results.append(r);print(json.dumps({k:r.get(k) for k in ['case','status','correct','seconds']}),flush=True)
pathlib.Path(sys.argv[1]).write_text(json.dumps({'health':health,'results':results},indent=2)+'\n')
if not all(r['correct'] for r in results):sys.exit(1)
