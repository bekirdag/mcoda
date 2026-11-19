#!/usr/bin/env python3
"""Operator-run Strata context qualification. Requires an already-drained node.
Restores the original profile/service unless --apply-context passes qualification.
Never changes mswarm configuration or kills other services.
"""
import argparse, concurrent.futures, hashlib, json, os, pathlib, subprocess, sys, time, urllib.request

p=argparse.ArgumentParser();p.add_argument('--sizes',default='32768,8192,16384,65536,131072,262144');p.add_argument('--output',required=True);p.add_argument('--repeat',type=int,default=1);p.add_argument('--original-profile');p.add_argument('--workload',action='store_true');p.add_argument('--apply-context',type=int);a=p.parse_args()
pid=subprocess.check_output(['systemctl','--user','show','strata-qwen-flash-next.service','-p','MainPID','--value'],text=True).strip()
command=pathlib.Path('/proc/'+pid+'/cmdline').read_bytes().decode().split('\0')
profile=pathlib.Path(command[command.index('--profile')+1]); original=pathlib.Path(a.original_profile).read_bytes() if a.original_profile else profile.read_bytes(); cfg=json.loads(original)
out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True);(out/'profile.original.json').write_bytes(original)
sys.path.insert(0,str(pathlib.Path(cfg['cwd'])/'tools'));import strata_tokenizer as ST
folder=pathlib.Path(cfg['tokenizer']);vocab=json.loads((folder/'vocab.json').read_text());tokens=[None]*len(vocab)
for t,i in vocab.items():tokens[i]=t
tc=json.loads((folder/'tokenizer.json').read_text());tok=ST.Tokenizer(tokens,(folder/'merges.txt').read_text().split('\n'),json.loads((folder/'token_type.json').read_text()),tc.get('pre') or 'qwen35',tc.get('special_ids') or None)
base='http://127.0.0.1:11452'; results=[]
def api(ep,data=None,timeout=600):
 req=urllib.request.Request(base+ep,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r)
def snapshot():
 mem=dict(line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
 gpu=subprocess.check_output(['nvidia-smi','--query-gpu=index,memory.used,memory.free,utilization.gpu','--format=csv,noheader,nounits'],text=True).strip()
 return {'available_ram_mib':int(mem['MemAvailable'].split()[0])//1024,'gpus':gpu}
def save(): (out/'results.json').write_text(json.dumps({'host':os.uname().nodename,'results':results},indent=2))
def ready(ctx):
 end=time.monotonic()+900
 while time.monotonic()<end:
  try:
   h=api('/health',timeout=3)
   if h.get('loaded') and h.get('max_context')==ctx:return h
  except Exception:pass
  time.sleep(3)
 raise RuntimeError('service failed readiness at context '+str(ctx))
def call(label,messages,max_tokens=256,tools=None,check=None):
 req={'model':'qwen-latest-flash-next','messages':messages,'max_tokens':max_tokens,'temperature':0}
 if tools:req['tools']=tools
 start=time.monotonic();peak=snapshot();record={'case':label,'max_output':max_tokens,'request_sha256':hashlib.sha256(json.dumps(req,sort_keys=True).encode()).hexdigest()}
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
  future=pool.submit(api,'/v1/chat/completions',req)
  while not future.done():
   time.sleep(1);sample=snapshot()
   if sample['available_ram_mib']<peak['available_ram_mib']:peak=sample
  try:
   response=future.result();message=response['choices'][0]['message'];record.update(response=response,correct=check(message) if check else None)
  except Exception as e:record.update(error=str(e),correct=False)
 record.update(seconds=round(time.monotonic()-start,3),lowest_ram_sample=peak);return record

def textcase(label,prompt,expected):
 return call(label,[{'role':'user','content':prompt}],check=lambda m:m.get('content','').strip()==expected)
def retrieval(target,case):
 # Fixed deterministic irrelevant records; planted facts at beginning, middle and end.
 unit='Ordinary inventory record: this item is inactive and has no special access code.\n';n=max(1,target//len(tok.encode(unit)))
 parts=[unit*(n//3),'AUTHORITY amber = 7319.\n',unit*(n//3),'AUTHORITY violet = 4826.\n',unit*(n-n//3*2),'AUTHORITY jade = 9053.\n']
 prompt='Return only the three AUTHORITY codes in order amber,violet,jade, separated by commas. Ignore ordinary records.\n'+''.join(parts)
 count=len(tok.encode(prompt));return call(case,[{'role':'user','content':prompt}],max_tokens=64,check=lambda m:m.get('content','').strip()=='7319,4826,9053')|{'encoded_content_tokens':count}
try:
 for size in map(int,a.sizes.split(',')):
  row={'context':size,'cases':[]};results.append(row);save();print(json.dumps({'event':'start','context':size}),flush=True)
  try:
   if snapshot()['available_ram_mib']<8000:raise RuntimeError('RAM headroom below 8GiB before restart')
   try: current_context=api('/health',timeout=5).get('max_context')
   except Exception: current_context=None
   effective_args=json.loads(profile.read_text())['args']; configured=int(effective_args[effective_args.index('--max-context')+1])
   if current_context!=size and not (current_context is None and configured==size):
    d=json.loads(original)
    for key in ['args','args_written']:
     if key in d:d[key][d[key].index('--max-context')+1]=str(size)
    profile.write_text(json.dumps(d,indent=2)+'\n');subprocess.run(['systemctl','--user','restart','strata-qwen-flash-next.service'],check=True,timeout=330)
   row['health']=ready(size);row['before']=snapshot();row['engine']=api('/metrics')['engine'];save()
   for repeat in range(a.repeat):
    cases=[lambda:textcase('arithmetic','Reply only the integer: 137*29 - 418.','3555'),lambda:textcase('logic','A is before B. C is after B. D is before A. Reply only the order of all four letters, no punctuation.','DABC'),lambda:textcase('code-reading','Python: def f(xs):\n    return [x*x for x in xs if x%2]\nWhat is f([0,1,2,3,4,5])? Reply only a JSON array, without spaces.','[1,9,25]'),lambda:retrieval(5500,'shared-5500'),lambda:retrieval(int(size*.82)-512,'near-capacity')]
    for run in cases:
     r=run();r['repeat']=repeat;row['cases'].append(r);save();print(json.dumps({'event':'case','context':size,'case':r['case'],'correct':r['correct'],'seconds':r['seconds'],'usage':r.get('response',{}).get('usage'),'error':r.get('error')}),flush=True)
     if r.get('error'):raise RuntimeError('request failure; stop this context')
    tools=[{'type':'function','function':{'name':'calculate','description':'Exact arithmetic','parameters':{'type':'object','properties':{'expression':{'type':'string'}},'required':['expression']}}}]
    r=call('tool-selection',[{'role':'user','content':'Use calculate to evaluate 19.99*3+5.50. Do not calculate mentally.'}],tools=tools,check=lambda m:any(c.get('function',{}).get('name')=='calculate' and json.loads(c['function']['arguments']).get('expression','').replace(' ','')=='19.99*3+5.50' for c in m.get('tool_calls',[])))
    row['cases'].append(r);save();print(json.dumps({'event':'case','context':size,'case':r['case'],'correct':r['correct'],'seconds':r['seconds']}),flush=True)
   if a.workload:
    workload=out/f'workload-{size}.json'
    subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('context-workload.py')),'--output',str(workload),'--tokens',str(min(20000,int(size*.55))),'--repeat','1'],check=True,timeout=1200)
    row['workload']=json.loads(workload.read_text())
   row['after']=snapshot();row['status']='completed'
  except Exception as e:
   row['status']='failed';row['error']=str(e);print(json.dumps({'event':'failure','context':size,'error':str(e)}),flush=True)
  save()
finally:
 final_context=int(cfg['args'][cfg['args'].index('--max-context')+1]); final_bytes=original
 decision={'requested':a.apply_context,'selected':final_context,'reason':'restore original'}
 if a.apply_context:
  import statistics
  baseline=next((x for x in results if x['context']==32768 and x.get('status')=='completed'),None)
  candidate=next((x for x in results if x['context']==a.apply_context and x.get('status')=='completed'),None)
  def decode_times(row):return [c['seconds'] for c in row.get('workload',{}).get('cases',[]) if c['name']=='output-budget' and c['max_output']>=2048 and c.get('correct')]
  if baseline and candidate and decode_times(baseline) and decode_times(candidate):
   ratio=statistics.median(decode_times(candidate))/statistics.median(decode_times(baseline))
   baseline_correct={c['case'] for c in baseline['cases'] if c.get('correct')}
   candidate_correct={c['case'] for c in candidate['cases'] if c.get('correct')}
   semantic=[c for c in candidate['workload']['cases'] if c['name']!='output-budget' or c['max_output']>=1024]
   qualifies=(ratio<=1.5 and baseline_correct<=candidate_correct and all(c.get('correct') for c in semantic) and candidate['workload']['concurrency']['correct'] and candidate['before']['available_ram_mib']>=8000)
   decision.update(qualified=qualifies,matched_generation_time_ratio=ratio)
   if qualifies:
    d=json.loads(original)
    for key in ['args','args_written']:
     if key in d:d[key][d[key].index('--max-context')+1]=str(a.apply_context)
    final_context=a.apply_context;final_bytes=(json.dumps(d,indent=2)+'\n').encode()
    decision.update(selected=final_context,reason='explicit candidate passed correctness, queue, memory and <=1.5x generation-time qualification; higher capacity alone is not preferred')
 (out/'decision.json').write_text(json.dumps(decision,indent=2))
 profile.write_bytes(final_bytes)
 subprocess.run(['systemctl','--user','restart','strata-qwen-flash-next.service'],check=True,timeout=330)
 ready(final_context);print(json.dumps({'event':'final-ready','context':final_context}),flush=True)
