#!/usr/bin/env python3
"""Deterministic field-level grading, separate from answering workers."""
import json,pathlib,sys,math,statistics,hashlib,csv
ROOT=pathlib.Path(__file__).resolve().parents[2]
CORPUS=ROOT/'docs/benchmarks/codali-industry50'
def readlines(path):
 return [json.loads(x) for x in pathlib.Path(path).read_text().splitlines() if x.strip()]
def extract(text):
 try:
  obj=json.loads(text)
  if isinstance(obj,dict):return obj,'json'
 except (ValueError,TypeError):pass
 # Ignore wrapper prose/fences but never silently repair malformed JSON.
 decoder=json.JSONDecoder();objects=[]
 for i,c in enumerate(text or ''):
  if c!='{':continue
  try:
   value,end=decoder.raw_decode(text[i:])
   if isinstance(value,dict):objects.append(value)
  except ValueError:pass
 return (max(objects,key=len),'wrapped-json') if objects else (None,'unparseable')
def equal(actual,expected):
 if isinstance(expected,bool) or expected is None:return type(actual)==type(expected) and actual==expected
 if isinstance(expected,(float,int)):
  return type(actual) in (int,float) and math.isfinite(actual) and abs(actual-expected)<=0.005
 if isinstance(expected,str):return isinstance(actual,str) and actual.strip().casefold()==expected.strip().casefold()
 if isinstance(expected,list):return isinstance(actual,list) and len(actual)==len(expected) and all(equal(a,e) for a,e in zip(actual,expected))
 if isinstance(expected,dict):return isinstance(actual,dict) and actual.keys()==expected.keys() and all(equal(actual[k],v) for k,v in expected.items())
 return False
def grade(text,key):
 obj,fmt=extract(text);checks=[]
 for c in key['criteria']:
  present=obj is not None and c['field'] in obj
  a=obj.get(c['field']) if obj is not None else None
  checks.append(dict(field=c['field'],expected=c['expected'],actual=a,present=present,passed=present and equal(a,c['expected']),weight=c['weight']))
 return dict(score=sum(c['weight'] for c in checks if c['passed']),format=fmt,checks=checks)
def audit(g,case_id,errata):
 checks=[dict(c) for c in g['checks']]
 for c in checks:
  if not c['present'] or c['passed']:continue
  alternatives=errata.get('alternatives',{}).get(case_id,{}).get(c['field'],[])
  accepted=any(equal(c['actual'],v) for v in alternatives)
  if case_id!='industry-24' and type(c['expected']) in (int,float) and isinstance(c['actual'],str):
   try:accepted=accepted or equal(float(c['actual'].strip()),c['expected'])
   except ValueError:pass
  if c['field'] in errata.get('unorderedFields',{}).get(case_id,[]) and isinstance(c['actual'],list):
   accepted=sorted(json.dumps(v,sort_keys=True) for v in c['actual'])==sorted(json.dumps(v,sort_keys=True) for v in c['expected'])
  if accepted:c.update(passed=True,audit_equivalence=True)
 return dict(score=sum(c['weight'] for c in checks if c['passed']),checks=checks)
def qualify(keys):
 assert len(keys)==50 and len({x['id'] for x in keys})==50
 for k in keys:
  assert len(k['criteria'])==5 and sum(c['weight'] for c in k['criteria'])==100
  assert grade(json.dumps(k['expected']),k)['score']==100
  assert grade('```json\n'+json.dumps(k['expected'])+'\n```',k)['score']==100
  assert grade('{}',k)['score']==0
  assert grade('not an answer',k)['score']==0
  for field in k['expected']:
   mutated=dict(k['expected']);del mutated[field]
   assert grade(json.dumps(mutated),k)['score']==80
 assert not equal(False,0) and not equal(True,1) and not equal('12',12)
 assert equal(1.234,1.23) and not equal(1.24,1.23)
 assert not equal([1,2],[2,1])
 return dict(cases=50,reference_checks=450,status='passed')
def qualify_audit(keys,errata):
 lookup={k['id']:k for k in keys};count=0
 for ident,fields in errata['alternatives'].items():
  for field,values in fields.items():
   for value in values:
    data=dict(lookup[ident]['expected']);data[field]=value
    assert audit(grade(json.dumps(data),lookup[ident]),ident,errata)['score']==100,(ident,field,value)
    count+=1
 for ident,fields in errata['unorderedFields'].items():
  for field in fields:
   data=dict(lookup[ident]['expected']);data[field]=list(reversed(data[field]))
   assert audit(grade(json.dumps(data),lookup[ident]),ident,errata)['score']==100
   count+=1
 for ident,field,value,score in [('industry-36','cap','18470',100),('industry-36','cap','18471',80),('industry-24','A','0',80),('industry-36','cap','NaN',80)]:
  data=dict(lookup[ident]['expected']);data[field]=value
  assert audit(grade(json.dumps(data),lookup[ident]),ident,errata)['score']==score
  count+=1
 return count
def main():
 keys=readlines(CORPUS/'grading.jsonl');manifest=json.loads((CORPUS/'manifest.json').read_text())
 for filename,key in [('prompts.jsonl','promptsSha256'),('grading.jsonl','gradingSha256')]:
  assert hashlib.sha256((CORPUS/filename).read_bytes()).hexdigest()==manifest[key]
 qualification=qualify(keys);errata=json.loads((CORPUS/'scoring-errata.json').read_text());qualification['audit_checks']=qualify_audit(keys,errata)
 (CORPUS/'qualification.json').write_text(json.dumps(qualification,indent=2)+'\n')
 if len(sys.argv)<2 or sys.argv[1]=='--qualify':print(json.dumps(qualification));return
 run=pathlib.Path(sys.argv[1]);ledger=readlines(run/'ledger.jsonl');results=[r for r in ledger if r['type']=='result'];lookup={k['id']:k for k in keys};scored=[]
 for row in results:
  r=row['result'];g=grade(r.get('content',''),lookup[r['caseId']]);audited=audit(g,r['caseId'],errata);events_path=pathlib.Path(row['directory'])/'events.jsonl';events=readlines(events_path) if events_path.exists() else []
  counts={};tools=[]
  for e in events:
   counts[e['type']]=counts.get(e['type'],0)+1
   if e['type'] in ('tool_call','tool_result','tool_intent','tool_receipt'):
    d=e.get('data',{});name=d.get('name') or d.get('tool') or d.get('call',{}).get('name') or d.get('receipt',{}).get('tool')
    if name:tools.append(name)
  u=r.get('usage') or {};tokens=u.get('totalTokens',u.get('tokens'));elapsed=r.get('answerElapsedMs',r.get('elapsedMs'))
  scored.append(dict(id=r['caseId'],arm=r['arm'],attemptId=r['attemptId'],**g,auditedScore=audited['score'],auditedChecks=audited['checks'],error=r.get('error'),completed=r.get('completed'),mode=r.get('mode'),tokens=tokens,usage=u,elapsedMs=elapsed,eventCounts=counts,tools=sorted(set(tools)),content=r.get('content','')))
 pairs=[]
 for k in keys:
  pair=dict(id=k['id'],title=k['title'])
  for arm in ['raw_direct','codali_selected']:
   matches=[s for s in scored if s['id']==k['id'] and s['arm']==arm]
   assert len(matches)<=1,'Duplicate attempts require an explicit separate analysis'
   pair[arm]=matches[0] if matches else None
  pairs.append(pair)
 summary={}
 for arm in ['raw_direct','codali_selected']:
  rows=[s for s in scored if s['arm']==arm];times=[s['elapsedMs'] for s in rows if s['elapsedMs'] is not None];tokens=[s['tokens'] for s in rows if s['tokens'] is not None]
  summary[arm]=dict(completed_attempts=len(rows),mean_score=statistics.mean(s['score'] for s in rows) if rows else None,audited_mean_score=statistics.mean(s['auditedScore'] for s in rows) if rows else None,audited_perfect_jobs=sum(s['auditedScore']==100 for s in rows),perfect_jobs=sum(s['score']==100 for s in rows),errors=sum(bool(s['error']) for s in rows),total_tokens=sum(tokens),token_coverage=len(tokens),total_elapsed_ms=sum(times),median_elapsed_ms=statistics.median(times) if times else None,non_json=sum(s['format']!='json' for s in rows))
 full=len(scored)==100
 if full:
  a,b=summary['codali_selected'],summary['raw_direct'];summary['comparison']=dict(audited_codali_wins=sum(p['codali_selected']['auditedScore']>p['raw_direct']['auditedScore'] for p in pairs),audited_raw_wins=sum(p['raw_direct']['auditedScore']>p['codali_selected']['auditedScore'] for p in pairs),audited_ties=sum(p['raw_direct']['auditedScore']==p['codali_selected']['auditedScore'] for p in pairs),audited_difference_pp=a['audited_mean_score']-b['audited_mean_score'],score_difference_pp=a['mean_score']-b['mean_score'],token_ratio=a['total_tokens']/b['total_tokens'] if b['total_tokens'] else None,time_ratio=a['total_elapsed_ms']/b['total_elapsed_ms'] if b['total_elapsed_ms'] else None,codali_wins=sum(p['codali_selected']['score']>p['raw_direct']['score'] for p in pairs),raw_wins=sum(p['raw_direct']['score']>p['codali_selected']['score'] for p in pairs),ties=sum(p['raw_direct']['score']==p['codali_selected']['score'] for p in pairs))
 out=dict(complete=full,qualification=qualification,scoringErrata=errata,corpus=manifest,summary=summary,pairs=pairs)
 (CORPUS/'results.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
 if full:
  with (CORPUS/'scores.csv').open('w',newline='') as f:
   writer=csv.writer(f,lineterminator='\n');writer.writerow(['id','job','codali_audited_score_pct','raw_audited_score_pct','codali_strict_score_pct','raw_strict_score_pct','codali_tokens','raw_tokens','codali_seconds','raw_seconds'])
   for p in pairs:
    a,b=p['codali_selected'],p['raw_direct'];writer.writerow([p['id'],p['title'],a['auditedScore'],b['auditedScore'],a['score'],b['score'],a['tokens'],b['tokens'],round(a['elapsedMs']/1000,3),round(b['elapsedMs']/1000,3)])
  lines=['# Scores: fresh industry-50','', '| # | Job | Codali | Raw Qwen |','|---:|---|---:|---:|']
  for i,p in enumerate(pairs,1):lines.append(f"| {i} | {p['title']} | {p['codali_selected']['auditedScore']}% | {p['raw_direct']['auditedScore']}% |")
  a,b=summary['codali_selected'],summary['raw_direct']
  lines.extend([f"| | **Average** | **{a['audited_mean_score']:.1f}%** | **{b['audited_mean_score']:.1f}%** |",'', 'Audited semantic scores; original strict scores preserved in CSV/JSON. All first attempts included; each job has five equal20-point criteria. See README.md for method and limitations.','',f"Reported total tokens: Codali {a['total_tokens']:,}; raw {b['total_tokens']:,}.",f"Sum of answer latency: Codali {a['total_elapsed_ms']/1000:.1f}s; raw {b['total_elapsed_ms']/1000:.1f}s."])
  (CORPUS/'scores.md').write_text('\n'.join(lines)+'\n')

 print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
