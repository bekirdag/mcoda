import { createHash } from "node:crypto";

export interface TerminalCorpusTask {
  id: string;
  family: string;
  variant: number;
  split: "development" | "held-out";
  prompt: string;
  files: Record<string, string>;
  allowedChanges: string[];
  /** Never materialized in the agent workspace. Used only to qualify the harness. */
  reference: Record<string, string>;
  /** Evaluator-owned checks, materialized only in an isolated grading copy after execution. */
  hiddenChecks: string;
  /** Evaluator-owned configuration; never exposed as an editable workspace file. */
  grading?: {
    entrypoint?: string | null;
    publicTestFiles?: string[];
    minimumPublicTests?: number;
    testFilesToExtend?: string[];
  };
}

interface Family {
  id: string;
  contract: string;
  starter: string;
  reference: string;
  checks: (seed: number) => string;
  smoke: string;
}
const families: Family[] = [
  {
    id: "clamp", contract: "Export clamp(value, minimum, maximum). Require finite numbers, reject minimum > maximum with RangeError, reject other invalid inputs with TypeError, preserve fractional values and clamp inclusively. Do not coerce strings.",
    starter: "export const clamp = (value, minimum, maximum) => Math.max(minimum, value);",
    reference: "export function clamp(value, minimum, maximum) { if (![value,minimum,maximum].every(Number.isFinite)) throw new TypeError('finite numbers required'); if (minimum > maximum) throw new RangeError('reversed range'); return Math.min(maximum, Math.max(minimum,value)); }",
    smoke: "assert.equal(m.clamp(20, 0, 10), 10);",
    checks: n => `for (const [v,lo,hi,want] of [[${n*4},0,${n},${n}],[-${n},0,${n},0],[0.25,0,1,0.25],[${n},${n},${n},${n}]]) assert.equal(m.clamp(v,lo,hi),want); for (const value of [NaN,Infinity,-Infinity,'2',null,undefined]) assert.throws(()=>m.clamp(value,0,3),TypeError); assert.throws(()=>m.clamp(1,4,2),RangeError);`,
  },
  {
    id: "chunk", contract: "Export chunk(items, size). Return new arrays of consecutive items, including a shorter final chunk. Empty input returns []. Reject non-array items with TypeError and nonpositive/noninteger sizes with RangeError. Never mutate the input.",
    starter: "export const chunk = (items, size) => [items.slice(0,size)];",
    reference: "export function chunk(items,size) { if (!Array.isArray(items)) throw new TypeError('array required'); if (!Number.isInteger(size)||size<1) throw new RangeError('positive integer required'); const out=[]; for(let i=0;i<items.length;i+=size) out.push(items.slice(i,i+size)); return out; }",
    smoke: "assert.deepEqual(m.chunk([1,2,3],2),[[1,2],[3]]);",
    checks: n => `const items=Object.freeze(Array.from({length:${n*3+1}},(_,i)=>i)); const out=m.chunk(items,${n}); assert.deepEqual(out.flat(),items); assert.equal(out.length,4); assert.equal(out.at(-1).length,1); assert.notEqual(out[0],items); assert.deepEqual(m.chunk([],2),[]); for(const size of [0,-1,1.5,NaN,Infinity,'2']) assert.throws(()=>m.chunk([],size),RangeError); assert.throws(()=>m.chunk(null,2),TypeError);`,
  },
  {
    id: "stable-unique", contract: "Export uniqueBy(items, key). key is a property name. Keep the first item for each key value using Map equality (including NaN and object identity), preserve order and references, and do not mutate the input. Missing keys are one undefined group. Reject non-array input.",
    starter: "export const uniqueBy = (items,key) => [...new Set(items)];",
    reference: "export function uniqueBy(items,key) { if(!Array.isArray(items)) throw new TypeError('array required'); const seen=new Set(); return items.filter(item=>{ const value=item[key]; if(seen.has(value)) return false; seen.add(value); return true; }); }",
    smoke: "assert.deepEqual(m.uniqueBy([{id:1,v:'a'},{id:1,v:'b'}],'id'),[{id:1,v:'a'}]);",
    checks: n => `const key='key${n}', obj={}; const values=[${n},${n},NaN,NaN,obj,obj,{},undefined,undefined]; const items=Object.freeze(values.map((v,i)=>Object.freeze({[key]:v,i}))); const out=m.uniqueBy(items,key); assert.deepEqual(out.map(v=>v.i),[0,2,4,6,7]); assert.equal(out[0],items[0]); assert.deepEqual(m.uniqueBy([{x:1},{x:2}],'missing'),[{x:1}]); assert.throws(()=>m.uniqueBy(null,key));`,
  },
  {
    id: "lower-bound", contract: "Export lowerBound(sorted, value), returning the first index whose number is >= value or the array length if absent. Sorted input is ascending and finite. Use logarithmic indexed reads, handle duplicates/empty input, and do not mutate the input.",
    starter: "export const lowerBound = (sorted,value) => sorted.findIndex(x=>x>=value);",
    reference: "export function lowerBound(sorted,value) { let lo=0,hi=sorted.length; while(lo<hi){const mid=lo+Math.floor((hi-lo)/2); if(sorted[mid]<value)lo=mid+1;else hi=mid;} return lo; }",
    smoke: "assert.equal(m.lowerBound([1,2,2,5],8),4);",
    checks: n => `assert.equal(m.lowerBound([],${n}),0); const a=Object.freeze([-${n},0,${n},${n},${n+1}]); assert.equal(m.lowerBound(a,${n}),2); assert.equal(m.lowerBound(a,-100),0); assert.equal(m.lowerBound(a,100),5); let reads=0; const big=new Proxy(Array.from({length:65536},(_,i)=>i*2),{get(t,k){if(typeof k==='string'&&/^[0-9]+$/.test(k))reads++;return Reflect.get(t,k);}}); assert.equal(m.lowerBound(big,65000+${n}),Math.ceil((65000+${n})/2)); assert.ok(reads>0&&reads<=20,'must use logarithmic indexed reads');`,
  },
  {
    id: "task-dag", contract: "Export orderTasks(tasks), where each task has unique string id and dependsOn string[]. Return IDs in topological order, choosing the lexicographically smallest currently-ready ID each time. Reject duplicate IDs, unknown prerequisites and cycles. Do not mutate tasks or dependency arrays.",
    starter: "export const orderTasks = tasks => tasks.map(t=>t.id).sort();",
    reference: "export function orderTasks(tasks) { const by=new Map(); for(const t of tasks){if(by.has(t.id))throw new Error('duplicate');by.set(t.id,t);} for(const t of tasks)for(const d of t.dependsOn)if(!by.has(d))throw new Error('missing'); const done=new Set(),out=[]; while(out.length<tasks.length){const ready=tasks.filter(t=>!done.has(t.id)&&t.dependsOn.every(d=>done.has(d))).map(t=>t.id).sort();if(!ready.length)throw new Error('cycle');out.push(ready[0]);done.add(ready[0]);}return out; }",
    smoke: "assert.deepEqual(m.orderTasks([{id:'a',dependsOn:['z']},{id:'z',dependsOn:[]}]),['z','a']);",
    checks: n => `const p='p${n}';const tasks=Object.freeze([{id:'a',dependsOn:Object.freeze([p])},{id:'b',dependsOn:Object.freeze([])},{id:p,dependsOn:Object.freeze([])}].map(Object.freeze));assert.deepEqual(m.orderTasks(tasks),['b',p,'a']);assert.deepEqual(m.orderTasks([]),[]);assert.throws(()=>m.orderTasks([{id:'a',dependsOn:['missing']}]));assert.throws(()=>m.orderTasks([{id:'a',dependsOn:[]},{id:'a',dependsOn:[]}]));assert.throws(()=>m.orderTasks([{id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']}]));assert.throws(()=>m.orderTasks([{id:'a',dependsOn:['a']}]));`,
  },
  {
    id: "relative-path", contract: "Export safePath(value). Accept only a nonempty POSIX relative path whose slash-separated components are nonempty and are neither the exact component '.' nor '..'. Reject absolute paths, backslashes, control characters U+0000-U+001F and U+007F-U+009F inclusive, drive prefixes and percent escapes (no decoding). Return valid paths unchanged; all invalid values throw TypeError. Unicode names and ordinary dots/hyphens within names are allowed.",
    starter: "export const safePath = value => value.replace('../','');",
    reference: "export function safePath(value) { if(typeof value!=='string'||!value||/[\\\\%\\x00-\\x1f\\x7f-\\x9f]/.test(value)||/^[A-Za-z]:/.test(value)||value.split('/').some(x=>!x||x==='.'||x==='..'))throw new TypeError('unsafe path');return value; }",
    smoke: "assert.throws(()=>m.safePath('../secret'),TypeError);",
    checks: n => `for(const value of ['src/file${n}.mjs','a.b/c-d','ü/文.txt','.hidden','..hidden','...','a\\u00a0b'])assert.equal(m.safePath(value),value);for(const value of ['',null,42,'/etc/passwd','a//b','a/./b','a/../b','a/','C:/x','a\\\\b','%2e%2e/x','x\\u0000y','x\\u001fy','x\\u007fy','x\\u0080y','x\\u009fy','a\\nb'])assert.throws(()=>m.safePath(value),TypeError);`,
  },
  {
    id: "journal-tail", contract: "Export readJournal(text). Parse newline-terminated JSON object records with contiguous positive integer seq starting at 1. Ignore any non-newline-terminated final fragment, even if valid JSON. Skip blank complete lines. Reject malformed complete JSON, arrays/null/nonobjects and missing/duplicate/gapped seq. Return records without changing their fields.",
    starter: "export const readJournal = text => text.trim().split('\\n').filter(Boolean).map(JSON.parse);",
    reference: "export function readJournal(text){const lines=text.split('\\n');lines.pop();const out=[];for(const line of lines){if(!line.trim())continue;const value=JSON.parse(line);if(!value||Array.isArray(value)||typeof value!=='object'||value.seq!==out.length+1)throw new Error('invalid sequence');out.push(value);}return out;}",
    smoke: "assert.deepEqual(m.readJournal('{\"seq\":1}\\n{\"seq\":'),[{seq:1}]);",
    checks: n => `const items=Array.from({length:${n}},(_,i)=>({seq:i+1,value:i}));const full=items.map(JSON.stringify).join('\\n')+'\\n';assert.deepEqual(m.readJournal(full+'{'),items);assert.deepEqual(m.readJournal(full+JSON.stringify({seq:${n+1}})),items);assert.deepEqual(m.readJournal(''),[]);assert.deepEqual(m.readJournal('  \\n'+full),items);for(const text of ['{bad}\\n','null\\n','[]\\n','{}\\n','{\"seq\":2}\\n','{\"seq\":1}\\n{\"seq\":1}\\n'])assert.throws(()=>m.readJournal(text));`,
  },
  {
    id: "ttl-lru", contract: "Export createCache(capacity, now), with get(key), set(key,value,ttlMs) and size(). Capacity is a positive integer; ttlMs must be positive finite. Expiry is inclusive (now >= expires means absent). Reads refresh LRU order but not expiry. On set, remove expired items and evict least recently used to capacity. size() excludes expired entries. Use injected now(), never the wall clock.",
    starter: "export function createCache(capacity,now){const map=new Map();return{get:key=>map.get(key),set:(key,value,ttl)=>map.set(key,value),size:()=>map.size};}",
    reference: "export function createCache(capacity,now){if(!Number.isInteger(capacity)||capacity<1)throw new RangeError('capacity');const map=new Map();const prune=()=>{const at=now();for(const[k,v]of map)if(at>=v.expires)map.delete(k);};return{get(key){prune();const v=map.get(key);if(!v)return undefined;map.delete(key);map.set(key,v);return v.value;},set(key,value,ttl){if(!Number.isFinite(ttl)||ttl<=0)throw new RangeError('ttl');prune();map.delete(key);map.set(key,{value,expires:now()+ttl});while(map.size>capacity)map.delete(map.keys().next().value);},size(){prune();return map.size;}};}",
    smoke: "let now=0;const cache=m.createCache(1,()=>now);cache.set('a',1,10);now=10;assert.equal(cache.get('a'),undefined);",
    checks: n => `let at=${n};const c=m.createCache(2,()=>at);c.set('a',1,10);c.set('b',2,20);assert.equal(c.get('a'),1);c.set('c',3,30);assert.equal(c.get('b'),undefined);at+=10;assert.equal(c.get('a'),undefined);assert.equal(c.size(),1);c.set('c',4,5);at+=5;assert.equal(c.size(),0);assert.throws(()=>m.createCache(0,()=>0));for(const ttl of [0,-1,Infinity,NaN])assert.throws(()=>c.set('x',1,ttl));`,
  },
  {
    id: "budget-receipts", contract: "Export createBudget(maxCalls,maxTokens) returning reserve(id,tokens), settle(id,tokens), snapshot(). Positive safe-integer caps required. Nonnegative safe-integer token amounts required. reserve rejects reused IDs and cap breaches without mutation. Reservations increment calls and tokens immediately. calls is cumulative and is never decremented by settlement. settle only once for a pending ID replaces its token reservation with actual token usage, even if reported usage exceeds the cap (then future admission fails). snapshot is a fresh {calls,tokens,pending} object. A lost response retains its reservation.",
    starter: "export function createBudget(){return{reserve(){},settle(){},snapshot(){return{calls:0,tokens:0,pending:0};}};}",
    reference: "export function createBudget(maxCalls,maxTokens){if(![maxCalls,maxTokens].every(x=>Number.isSafeInteger(x)&&x>0))throw new RangeError('caps');let calls=0,tokens=0;const all=new Set(),pending=new Map();const check=n=>{if(!Number.isSafeInteger(n)||n<0)throw new RangeError('tokens');};return{reserve(id,n){check(n);if(all.has(id)||calls>=maxCalls||tokens+n>maxTokens)throw new Error('admission');all.add(id);pending.set(id,n);calls++;tokens+=n;},settle(id,n){check(n);if(!pending.has(id))throw new Error('receipt');tokens+=n-pending.get(id);pending.delete(id);},snapshot(){return{calls,tokens,pending:pending.size};}};}",
    smoke: "const b=m.createBudget(1,10);b.reserve('a',5);assert.throws(()=>b.reserve('b',1));",
    checks: n => `const b=m.createBudget(3,${n*10});b.reserve('a',${n});b.reserve('lost',${n});assert.deepEqual(b.snapshot(),{calls:2,tokens:${2*n},pending:2});assert.throws(()=>b.reserve('a',1));assert.throws(()=>b.settle('missing',1));b.settle('a',${n*11});assert.deepEqual(b.snapshot(),{calls:2,tokens:${12*n},pending:1});assert.throws(()=>b.reserve('next',0));assert.throws(()=>b.settle('a',0));const view=b.snapshot();view.tokens=0;assert.equal(b.snapshot().tokens,${12*n});for(const value of [-1,NaN,Infinity,1.5])assert.throws(()=>b.settle('lost',value));`,
  },
  {
    id: "binding-resolution", contract: "Export resolveBinding(config,name). config has models and bindings object maps. A binding has either nonempty candidates of model IDs or useBinding naming another binding. Resolve aliases; reject unknown bindings/models, cycles, mixed candidates/useBinding and duplicate candidate IDs. Preserve candidate order. Return a new array of model objects deeply cloned from config, so caller mutation cannot change config. Do not mutate config.",
    starter: "export const resolveBinding = (config,name) => config.bindings[name].candidates.map(id=>config.models[id]);",
    reference: "export function resolveBinding(config,name){const seen=new Set();while(true){if(seen.has(name)||!Object.hasOwn(config.bindings,name))throw new Error('binding');seen.add(name);const b=config.bindings[name];if(b.useBinding!==undefined){if(b.candidates!==undefined)throw new Error('mixed');name=b.useBinding;continue;}if(!Array.isArray(b.candidates)||!b.candidates.length||new Set(b.candidates).size!==b.candidates.length)throw new Error('candidates');return b.candidates.map(id=>{if(!Object.hasOwn(config.models,id))throw new Error('model');return structuredClone(config.models[id]);});}}",
    smoke: "assert.deepEqual(m.resolveBinding({models:{a:{id:'a'}},bindings:{lead:{useBinding:'base'},base:{candidates:['a']}}},'lead'),[{id:'a'}]);",
    checks: n => `const c={models:{a:{id:'a',limits:{n:${n}}},b:{id:'b'}},bindings:{lead:{useBinding:'base'},base:{candidates:['b','a']}}};const r=m.resolveBinding(c,'lead');assert.deepEqual(r.map(x=>x.id),['b','a']);r[1].limits.n=0;assert.equal(c.models.a.limits.n,${n});assert.throws(()=>m.resolveBinding(c,'toString'));for(const bindings of [{a:{useBinding:'b'},b:{useBinding:'a'}},{a:{candidates:['missing']}},{a:{candidates:['a','a']}},{a:{useBinding:'b',candidates:['a']}},{a:{candidates:[]}}])assert.throws(()=>m.resolveBinding({models:c.models,bindings},'a'));`,
  },
  {
    id: "bounded-retry", contract: "Export async retry(operation,{attempts,delay,signal}). Call operation with a 1-based attempt. Retry only errors whose retryable is exactly true; attempts is a positive integer total-attempt cap. Await injected delay(attempt,signal) between attempts only. Before every operation and after every delay check signal and throw signal.reason if aborted. Never retry cancellation or a delay failure. Return first successful result; exhausted retries throw the last operation error.",
    starter: "export const retry = async operation => operation(1);",
    reference: "export async function retry(operation,{attempts,delay,signal}){if(!Number.isInteger(attempts)||attempts<1)throw new RangeError('attempts');for(let attempt=1;attempt<=attempts;attempt++){signal?.throwIfAborted();try{return await operation(attempt);}catch(error){signal?.throwIfAborted();if(error?.retryable!==true||attempt===attempts)throw error;await delay(attempt,signal);signal?.throwIfAborted();}}}",
    smoke: "let calls=0;assert.equal(await m.retry(async()=>{if(++calls<2)throw Object.assign(new Error('retry'),{retryable:true});return 7;},{attempts:2,delay:async()=>{}}),7);",
    checks: n => `let calls=0;const delays=[];const e=Object.assign(new Error('temporary'),{retryable:true});assert.equal(await m.retry(async attempt=>{calls++;if(attempt<${n})throw e;return attempt;},{attempts:${n},delay:async attempt=>{delays.push(attempt);}}),${n});assert.equal(calls,${n});assert.deepEqual(delays,Array.from({length:${n-1}},(_,i)=>i+1));const ac=new AbortController();const stop=new Error('stop');calls=0;await assert.rejects(m.retry(async()=>{calls++;throw e;},{attempts:3,signal:ac.signal,delay:async()=>ac.abort(stop)}),x=>x===stop);assert.equal(calls,1);calls=0;await assert.rejects(m.retry(async()=>{calls++;throw new Error('permanent');},{attempts:3,delay:async()=>{throw new Error('wrong');}}),/permanent/);assert.equal(calls,1);`,
  },
  {
    id: "phase-coverage", contract: "Export validatePlan(requirements,tasks). Requirements is a list of unique string IDs. Each task has unique id, requirementIds and dependsOn arrays. Reject duplicate requirement/task IDs, missing requirement coverage, unknown requirement refs, unknown task dependencies, and dependency cycles. Empty requirements/tasks is valid. Return {covered: requirements.length, tasks: tasks.length}. Do not mutate input. A requirement may be covered by several tasks.",
    starter: "export const validatePlan = (requirements,tasks) => ({covered:requirements.length,tasks:tasks.length});",
    reference: "export function validatePlan(requirements,tasks){const req=new Set(requirements),ids=new Set(tasks.map(t=>t.id)),covered=new Set();if(req.size!==requirements.length||ids.size!==tasks.length)throw new Error('duplicate');for(const t of tasks){for(const r of t.requirementIds){if(!req.has(r))throw new Error('requirement');covered.add(r);}for(const d of t.dependsOn)if(!ids.has(d))throw new Error('dependency');}if(covered.size!==req.size)throw new Error('coverage');const done=new Set();while(done.size<tasks.length){const ready=tasks.filter(t=>!done.has(t.id)&&t.dependsOn.every(d=>done.has(d)));if(!ready.length)throw new Error('cycle');for(const t of ready)done.add(t.id);}return{covered:req.size,tasks:tasks.length};}",
    smoke: "assert.throws(()=>m.validatePlan(['R1'],[]));",
    checks: n => `const req=Array.from({length:${n}},(_,i)=>'R'+i);const task={id:'all',requirementIds:req,dependsOn:[]};assert.deepEqual(m.validatePlan(req,[task]),{covered:${n},tasks:1});assert.deepEqual(m.validatePlan([],[]),{covered:0,tasks:0});assert.throws(()=>m.validatePlan([...req,req[0]],[task]));assert.throws(()=>m.validatePlan(req,[task,task]));assert.throws(()=>m.validatePlan(req,[{...task,requirementIds:req.slice(1)}]));assert.throws(()=>m.validatePlan(req,[{...task,requirementIds:[...req,'unknown']} ]));assert.throws(()=>m.validatePlan(req,[{...task,dependsOn:['missing']} ]));assert.throws(()=>m.validatePlan(req,[{...task,dependsOn:['all']} ]));`,
  },
];

export const TERMINAL_CORPUS_VERSION = "terminal-coding-v3";
/** One development case plus five held-out seeds per family. These are correlated variants,
 * not 60 independent problem domains. Report family results and retain the long-session corpus. */
export const terminalTaskCorpus = (): TerminalCorpusTask[] => families.flatMap(family => Array.from({ length: 6 }, (_, variant) => {
  const id = `${family.id}-${variant + 1}`; const seed = variant + 2;
  const contract = `${family.contract}\nQualification case: ${id}.`;
  return { id, family: family.id, variant: variant + 1, split: variant === 0 ? "development" : "held-out",
    prompt: `Complete the implementation in src/task.mjs for this repository.\n${contract}\nRequirements: implement the full documented contract, add meaningful public tests in test/task.test.mjs, run the tests, and preserve USER_NOTES.txt and package.json exactly. Only src/task.mjs and test/task.test.mjs may change. Do not add dependencies or unrelated features. Keep the original objective and constraints through any planning, helper calls or compaction.`,
    files: { "package.json": JSON.stringify({ name: `codali-eval-${id}`, private: true, type: "module", scripts: { test: "node --test test/task.test.mjs" } }, null, 2) + "\n",
      "USER_NOTES.txt": `User-owned note for ${id}: keep this file exactly as written.\n`,
      "src/task.mjs": `// ${contract.replace(/\n/g, "\n// ")}\n${family.starter}\n`,
      "test/task.test.mjs": `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/task.mjs';\ntest('public contract example', async()=>{${family.smoke}});\n` },
    allowedChanges: ["src/task.mjs", "test/task.test.mjs"], reference: { "src/task.mjs": family.reference + "\n" },
    hiddenChecks: family.checks(seed),
  };
}));
export const terminalCorpusHash = (): string => createHash("sha256").update(JSON.stringify({ version: TERMINAL_CORPUS_VERSION, tasks: terminalTaskCorpus() })).digest("hex");
