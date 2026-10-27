import { createHash } from "node:crypto";
import type { TerminalCorpusTask } from "./TerminalTaskCorpus.js";

interface CodingCase {
  id: string;
  contract: string;
  files: Record<string, string>;
  reference: Record<string, string>;
  smoke: string;
  checks: string;
}

// Independent contracts, not reskinned seeds of TerminalTaskCorpus. References
// and hidden checks are evaluator-owned and never materialized for the agent.
const coding: CodingCase[] = [
  {
    id: "invoice-cents",
    contract: "Implement parsePrice(text) in src/money.mjs and invoice(lines) in src/task.mjs. A price is an ASCII decimal string with one or more digits, optionally a dot and exactly one or two decimal digits; no signs, whitespace or exponent. parsePrice returns BigInt cents and throws TypeError otherwise. Each invoice line has price and a positive safe-integer quantity. invoice returns the exact total cents as a decimal string, including 0 for no lines. Invalid quantity throws RangeError. Never use floating-point money arithmetic or mutate lines. Keep the money helper as the single parser used by invoice.",
    files: { "src/money.mjs": "export const parsePrice = text => BigInt(Math.round(Number(text)*100));\n", "src/task.mjs": "import {parsePrice} from './money.mjs';\nexport const invoice = lines => String(lines.reduce((n,l)=>n+parsePrice(l.price),0n));\n" },
    reference: { "src/money.mjs": "export function parsePrice(text){if(typeof text!=='string'||!/^\\d+(?:\\.\\d{1,2})?$/.test(text))throw new TypeError('price');const [whole,fraction='']=text.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));}\n", "src/task.mjs": "import {parsePrice} from './money.mjs';\nexport function invoice(lines){let total=0n;for(const l of lines){if(!Number.isSafeInteger(l.quantity)||l.quantity<1)throw new RangeError('quantity');total+=parsePrice(l.price)*BigInt(l.quantity);}return String(total);}\n" },
    smoke: "assert.equal(m.invoice([{price:'1.25',quantity:3}]),'375');",
    checks: "const {parsePrice}=await import('./src/money.mjs');assert.equal(parsePrice('0001.2'),120n);assert.equal(m.invoice([]),'0');assert.equal(m.invoice(Object.freeze([Object.freeze({price:'9007199254740993.01',quantity:3})])),'2702159776422297903');for(const p of ['1.234',' 1','1.','-1','1e2','',1,null])assert.throws(()=>parsePrice(p),TypeError);for(const quantity of [0,-1,1.5,NaN,Infinity,'2'])assert.throws(()=>m.invoice([{price:'1',quantity}]),RangeError);",
  },
  {
    id: "jsonl-import",
    contract: "Fix parseRecords(text) in src/records.mjs and summarize(text) in src/task.mjs. Parse LF/CRLF JSONL, skip whitespace-only lines, require each record to have string id and nonnegative safe-integer count. Reject malformed JSON or invalid records with Error.message exactly 'Invalid record at line N', using the original 1-based line including blanks. summarize deduplicates by id keeping the LAST count, sorts ids in ascending JS string order, returns {ids,total}; reject unsafe total with RangeError. Empty input produces empty ids and total 0. Preserve records not provided by callers; no global state between calls.",
    files: { "src/records.mjs": "export const parseRecords = text => text.split('\\n').filter(Boolean).map(JSON.parse);\n", "src/task.mjs": "import {parseRecords} from './records.mjs';\nexport const summarize = text => ({ids:parseRecords(text).map(x=>x.id),total:0});\n" },
    reference: { "src/records.mjs": "export function parseRecords(text){const out=[];for(const [i,line]of text.split('\\n').entries()){if(!line.trim())continue;try{const r=JSON.parse(line);if(!r||typeof r.id!=='string'||!Number.isSafeInteger(r.count)||r.count<0)throw new Error();out.push(r);}catch{throw new Error('Invalid record at line '+(i+1));}}return out;}\n", "src/task.mjs": "import {parseRecords} from './records.mjs';\nexport function summarize(text){const by=new Map(parseRecords(text).map(r=>[r.id,r.count]));const ids=[...by.keys()].sort();const total=ids.reduce((n,id)=>n+by.get(id),0);if(!Number.isSafeInteger(total))throw new RangeError('total');return{ids,total};}\n" },
    smoke: "assert.deepEqual(m.summarize('{\"id\":\"b\",\"count\":2}\\n{\"id\":\"a\",\"count\":3}'),{ids:['a','b'],total:5});",
    checks: "const {parseRecords}=await import('./src/records.mjs');assert.deepEqual(m.summarize(' \\r\\n'+JSON.stringify({id:'__proto__',count:9})+'\\r\\n'+JSON.stringify({id:'__proto__',count:2})),{ids:['__proto__'],total:2});assert.deepEqual(m.summarize(''),{ids:[],total:0});for(const line of ['{','null','{}','{\"id\":\"x\",\"count\":-1}'])assert.throws(()=>parseRecords('\\n \\n'+line),{message:'Invalid record at line 3'});assert.throws(()=>m.summarize(JSON.stringify({id:'a',count:Number.MAX_SAFE_INTEGER})+'\\n'+JSON.stringify({id:'b',count:1})),RangeError);",
  },
  {
    id: "locale-fallback",
    contract: "Implement lookup(catalogs,locales,key) in src/catalog.mjs and translate(catalogs,locales,key,vars) in src/task.mjs. lookup scans locales in supplied order, accepting only own locale and own key properties with string values; an empty string is a valid translation. If none, return key. translate replaces tokens of exactly the form {ASCII letters/digits/underscore} only when vars owns that name; substitute String(value) literally, including dollar signs. Leave unknown tokens untouched. Do not replace replacement text recursively or mutate catalogs/vars. src/task.mjs must use the lookup helper.",
    files: { "src/catalog.mjs": "export const lookup=(catalogs,locales,key)=>catalogs[locales[0]]?.[key]||key;\n", "src/task.mjs": "import {lookup} from './catalog.mjs';\nexport const translate=(c,l,k,v)=>lookup(c,l,k);\n" },
    reference: { "src/catalog.mjs": "export function lookup(catalogs,locales,key){for(const locale of locales){if(!Object.hasOwn(catalogs,locale))continue;const c=catalogs[locale];if(c&&Object.hasOwn(c,key)&&typeof c[key]==='string')return c[key];}return key;}\n", "src/task.mjs": "import {lookup} from './catalog.mjs';\nexport function translate(c,l,k,v){return lookup(c,l,k).replace(/\\{([A-Za-z0-9_]+)\\}/g,(all,name)=>Object.hasOwn(v,name)?String(v[name]):all);}\n" },
    smoke: "assert.equal(m.translate({en:{hello:'Hi {name}'}},['tr','en'],'hello',{name:'Ada'}),'Hi Ada');",
    checks: "const {lookup}=await import('./src/catalog.mjs');const c=Object.assign(Object.create({evil:{x:'bad'}}),{en:Object.assign(Object.create({hidden:'bad'}),{blank:'',line:'{x} {missing} {toString}'})});assert.equal(lookup(c,['evil'],'x'),'x');assert.equal(lookup(c,['en'],'hidden'),'hidden');assert.equal(lookup(c,['en'],'blank'),'');assert.equal(m.translate(c,['en'],'line',{x:'$&{x}'}),'$&{x} {missing} {toString}');assert.equal(m.translate(c,['en'],'{x} {x}',{x:0}),'0 0');",
  },
  {
    id: "header-normalization",
    contract: "Refactor src/task.mjs to use src/headers.mjs normalizeHeaders(entries), where entries is an array of [name,value] strings. Normalize names to lower-case after trimming ASCII space/tab only, reject empty names or any non-token ASCII character (valid token chars: letters, digits, !#$%&'*+-.^_`|~). Trim ASCII space/tab from values; reject any CR/LF anywhere in a value. Join duplicate normalized names in encounter order with ', '. Return a fresh null-prototype object so __proto__ is an ordinary key. buildRequest(entries,body) returns {headers,body}, preserving the exact body reference; no input mutation.",
    files: { "src/headers.mjs": "export const normalizeHeaders = entries => Object.fromEntries(entries);\n", "src/task.mjs": "export const buildRequest=(entries,body)=>({headers:Object.fromEntries(entries),body});\n" },
    reference: { "src/headers.mjs": "export function normalizeHeaders(entries){const out=Object.create(null);for(const [raw,value]of entries){if(typeof raw!=='string'||typeof value!=='string')throw new TypeError('strings');const name=raw.replace(/^[ \\t]+|[ \\t]+$/g,'').toLowerCase();if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)||/[\\r\\n]/.test(value))throw new TypeError('header');const v=value.replace(/^[ \\t]+|[ \\t]+$/g,'');out[name]=Object.hasOwn(out,name)?out[name]+', '+v:v;}return out;}\n", "src/task.mjs": "import {normalizeHeaders} from './headers.mjs';\nexport const buildRequest=(entries,body)=>({headers:normalizeHeaders(entries),body});\n" },
    smoke: "assert.equal(m.buildRequest([['X-Id','a'],[' x-ID ','b']],null).headers['x-id'],'a, b');",
    checks: "const {normalizeHeaders}=await import('./src/headers.mjs');const body={};const h=m.buildRequest(Object.freeze([Object.freeze(['__proto__','ok'])]),body);assert.equal(Object.getPrototypeOf(h.headers),null);assert.equal(h.headers.__proto__,'ok');assert.equal(h.body,body);assert.equal(normalizeHeaders([['X','  a\\t'],['x','']]).x,'a, ');for(const name of ['','a:b','a b','é','\\nx'])assert.throws(()=>normalizeHeaders([[name,'x']]));for(const v of ['a\\nb','a\\rb'])assert.throws(()=>normalizeHeaders([['x',v]]));",
  },
  {
    id: "async-worker-pool",
    contract: "Implement mapPool(items,limit,worker) in src/pool.mjs and doubleAll(items,limit) in src/task.mjs using that helper. mapPool invokes async worker(item,index) at most limit concurrently, preserves result order, accepts empty arrays, rejects nonpositive/noninteger limits with RangeError. On any worker rejection, stop dispatching new items, await all already-started workers, then reject with the FIRST observed error. A worker throwing synchronously follows the same rule. Do not mutate items. doubleAll uses mapPool to multiply each number by 2; do not implement a second pool.",
    files: { "src/pool.mjs": "export const mapPool=async(items,limit,worker)=>Promise.all(items.map(worker));\n", "src/task.mjs": "export const doubleAll=async items=>items.map(x=>x*2);\n" },
    reference: { "src/pool.mjs": "export async function mapPool(items,limit,worker){if(!Number.isInteger(limit)||limit<1)throw new RangeError('limit');const out=new Array(items.length);let next=0,failed=false,first;async function lane(){while(!failed&&next<items.length){const i=next++;try{out[i]=await worker(items[i],i);}catch(e){if(!failed){failed=true;first=e;}}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},lane));if(failed)throw first;return out;}\n", "src/task.mjs": "import {mapPool} from './pool.mjs';\nexport const doubleAll=(items,limit)=>mapPool(items,limit,async x=>x*2);\n" },
    smoke: "assert.deepEqual(await m.doubleAll([2,4],1),[4,8]);",
    checks: "const {mapPool}=await import('./src/pool.mjs');let active=0,peak=0;assert.deepEqual(await mapPool(Object.freeze([1,2,3,4]),2,async(x,i)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return x+i;}),[1,3,5,7]);assert.equal(peak,2);let release;const gate=new Promise(r=>release=r);const started=[];const boom=new Error('first');let settled=false;const p=mapPool([0,1,2,3],2,async x=>{started.push(x);if(x===0)throw boom;await gate;return x;}).then(()=>{settled=true;throw new Error('unexpected');},e=>{settled=true;return e;});await new Promise(r=>setTimeout(r,5));assert.equal(settled,false);assert.deepEqual(started,[0,1]);release();assert.equal(await p,boom);for(const n of [0,-1,1.5,NaN])await assert.rejects(async()=>await mapPool([],n,async()=>0),RangeError);assert.deepEqual(await mapPool([],2,async()=>0),[]);",
  },
  {
    id: "interval-reservation",
    contract: "Implement overlaps(a,b) in src/interval.mjs and reserve(existing,candidate) in src/task.mjs. Intervals are half-open [start,end) finite-number bounds with start < end; invalid intervals throw RangeError even when the other list is empty. Endpoint touching is not overlap. reserve validates every interval before changing anything, rejects any overlap between candidate and existing with Error('conflict'), otherwise returns a new start-sorted array of fresh {start,end} objects, preserving equal-start order. Existing intervals may overlap each other; do not reject that. Ignore extra properties, never mutate inputs, do not share interval objects in output.",
    files: { "src/interval.mjs": "export const overlaps=(a,b)=>a.start<=b.end&&b.start<=a.end;\n", "src/task.mjs": "export const reserve=(existing,candidate)=>[...existing,candidate];\n" },
    reference: { "src/interval.mjs": "export function validate(x){if(!x||!Number.isFinite(x.start)||!Number.isFinite(x.end)||x.start>=x.end)throw new RangeError('interval');}\nexport function overlaps(a,b){validate(a);validate(b);return a.start<b.end&&b.start<a.end;}\n", "src/task.mjs": "import {overlaps,validate} from './interval.mjs';\nexport function reserve(existing,candidate){validate(candidate);for(const x of existing)validate(x);if(existing.some(x=>overlaps(x,candidate)))throw new Error('conflict');return [...existing,candidate].map(({start,end})=>({start,end})).sort((a,b)=>a.start-b.start);}\n" },
    smoke: "assert.deepEqual(m.reserve([{start:0,end:1}],{start:1,end:2}),[{start:0,end:1},{start:1,end:2}]);",
    checks: "const {overlaps}=await import('./src/interval.mjs');assert.equal(overlaps({start:0,end:2},{start:2,end:3}),false);assert.throws(()=>m.reserve([],{start:1,end:1}),RangeError);assert.throws(()=>m.reserve([{start:NaN,end:3}],{start:5,end:6}),RangeError);assert.throws(()=>m.reserve([{start:0,end:2}],{start:1,end:3}),{message:'conflict'});const a=Object.freeze({start:0,end:3,extra:1});const b=Object.freeze({start:1,end:2});const out=m.reserve(Object.freeze([a,b]),Object.freeze({start:4,end:5}));assert.notEqual(out[0],a);assert.deepEqual(out[0],{start:0,end:3});",
  },
  {
    id: "csv-export",
    contract: "Implement cell(value) in src/csv.mjs and exportRows(rows) in src/task.mjs. Cells accept string, number, boolean, null or undefined; null/undefined become empty, others String(value). Quote a cell exactly when it contains comma, double quote, CR or LF; double every internal quote. exportRows joins cells with commas and rows with CRLF, with a final CRLF for a nonempty list and empty string for no rows. Preserve empty rows as CRLF; never trim data or mutate input. Use the shared cell helper.",
    files: { "src/csv.mjs": "export const cell=value=>String(value??'');\n", "src/task.mjs": "export const exportRows=rows=>rows.map(row=>row.join(',')).join('\\n');\n" },
    reference: { "src/csv.mjs": "export function cell(value){const s=value==null?'':String(value);return /[,\"\\r\\n]/.test(s)?'\"'+s.replace(/\"/g,'\"\"')+'\"':s;}\n", "src/task.mjs": "import {cell} from './csv.mjs';\nexport const exportRows=rows=>rows.length?rows.map(row=>row.map(cell).join(',')).join('\\r\\n')+'\\r\\n':'';\n" },
    smoke: "assert.equal(m.exportRows([['a,b','c']]),'\"a,b\",c\\r\\n');",
    checks: "const {cell}=await import('./src/csv.mjs');assert.equal(cell('a\"b'),'\"a\"\"b\"');assert.equal(cell(' x '),' x ');assert.equal(cell(false),'false');assert.equal(m.exportRows([]),'');assert.equal(m.exportRows([[]]),'\\r\\n');assert.equal(m.exportRows(Object.freeze([Object.freeze([null,undefined,0,'a\\nb'])])),',,0,\"a\\nb\"\\r\\n');",
  },
  {
    id: "additive-record-migration",
    contract: "Implement migrate(document) in src/task.mjs using validateV1 in src/schema.mjs. Input schemaVersion must be exactly 1; records must be an array with unique string ids and string names. Reject invalid documents with TypeError. Output is a deep clone preserving ALL existing document/record fields, with schemaVersion 2 and a displayName field set to name only when displayName was not already an own property (preserve empty string/null). Do not alter source objects, reorder records or delete any published field. Already-v2 input must be rejected instead of silently reprocessed.",
    files: { "src/schema.mjs": "export const validateV1=document=>document;\n", "src/task.mjs": "export const migrate=document=>({schemaVersion:2,records:document.records.map(r=>({id:r.id,displayName:r.name}))});\n" },
    reference: { "src/schema.mjs": "export function validateV1(d){if(!d||d.schemaVersion!==1||!Array.isArray(d.records))throw new TypeError('document');const ids=new Set();for(const r of d.records){if(!r||typeof r.id!=='string'||typeof r.name!=='string'||ids.has(r.id))throw new TypeError('record');ids.add(r.id);}return d;}\n", "src/task.mjs": "import {validateV1} from './schema.mjs';\nexport function migrate(document){validateV1(document);const out=structuredClone(document);out.schemaVersion=2;for(const r of out.records)if(!Object.hasOwn(r,'displayName'))r.displayName=r.name;return out;}\n" },
    smoke: "assert.deepEqual(m.migrate({schemaVersion:1,records:[{id:'a',name:'A',published:true}]}).records,[{id:'a',name:'A',published:true,displayName:'A'}]);",
    checks: "const d={schemaVersion:1,metadata:{keep:[1]},records:[{id:'a',name:'A',displayName:''},{id:'b',name:'B',displayName:null},{id:'c',name:'C',history:[1]}]};const before=structuredClone(d);const out=m.migrate(d);assert.deepEqual(d,before);assert.equal(out.records[0].displayName,'');assert.equal(out.records[1].displayName,null);assert.equal(out.records[2].displayName,'C');out.metadata.keep.push(2);out.records[2].history.push(2);assert.deepEqual(d,before);for(const bad of [null,{schemaVersion:2,records:[]},{schemaVersion:1,records:[{id:'x',name:'x'},{id:'x',name:'y'}]},{schemaVersion:1,records:[{id:1,name:'x'}]}])assert.throws(()=>m.migrate(bad),TypeError);",
  },
];

interface ReportCase { id: string; question: string; files: Record<string, string>; expected: Record<string, unknown> }
const reports: ReportCase[] = [
  { id: "investigate-cache-expiry", question: "Investigate why a cached value disappears at its expiry timestamp. Do not change implementation. Write docs/report.json with exactly these keys: entrypoint (path), owner (path), unit ('milliseconds' or 'seconds'), boundary ('inclusive' or 'exclusive'), repair (one of 'change-greater-than', 'change-greater-or-equal', 'no-change'), and evidence (array of source paths). The required behavior is: expired when now >= expiresAt. Report the minimal correction needed.",
    files: { "src/api.mjs": "import {readCached} from './cache.mjs';\nexport const getItem=(store,key,now)=>readCached(store,key,now);\n", "src/cache.mjs": "export function readCached(store,key,now){const entry=store.get(key);if(!entry)return undefined;if(now>=entry.expiresAt){store.delete(key);return undefined;}return entry.value;}\n", "docs/clock.md": "now and expiresAt are epoch milliseconds. Expiry is inclusive.\n" },
    expected: { entrypoint: "src/api.mjs", owner: "src/cache.mjs", unit: "milliseconds", boundary: "inclusive", repair: "no-change", evidence: ["docs/clock.md", "src/api.mjs", "src/cache.mjs"] } },
  { id: "investigate-duplicate-submit", question: "Investigate duplicate billing after a retry using only this fixture. Do not repair code. Write docs/report.json with exactly: client (path), server (path), cause (one of 'new-id-per-attempt', 'missing-dedup', 'shared-tenant-key'), remedy (one of 'reuse-operation-id', 'disable-retries', 'remove-dedup'), and evidence (sorted array of source paths). Identify the client/server interaction, not an unsupported infrastructure theory.",
    files: { "src/client.mjs": "export async function charge(send,amount){for(let attempt=0;attempt<2;attempt++){try{return await send({operationId:crypto.randomUUID(),amount});}catch(e){if(attempt===1)throw e;}}}\n", "src/server.mjs": "const seen=new Map();\nexport async function handle(tenant,request,bill){const key=tenant+':'+request.operationId;if(seen.has(key))return seen.get(key);const result=await bill(request.amount);seen.set(key,result);return result;}\n", "docs/incident.md": "The first bill completed and its result was stored, but the response was lost. The retry then billed again. No concurrent requests occurred.\n" },
    expected: { client: "src/client.mjs", server: "src/server.mjs", cause: "new-id-per-attempt", remedy: "reuse-operation-id", evidence: ["docs/incident.md", "src/client.mjs", "src/server.mjs"] } },
  { id: "research-pinned-upgrade", question: "Research a fictional service upgrade using the pinned vendor documents in vendor-docs only; no internet claims are needed. Write docs/report.json with exactly: version ('1' or '2'), submitPath (string), pollPath (string with {id}), cancelMethod (string), retrySubmit (boolean), citations (sorted source-path array). Choose the version that supports polling and cancellation. A lost submit response must not be automatically retried unless the chosen version documents idempotency. Do not change the vendor documents or application.",
    files: { "vendor-docs/v1.md": "Fictional service v1. POST /v1/render synchronously returns a render. No status endpoint. No cancellation. Requests may be retried safely with Idempotency-Key.\n", "vendor-docs/v2.md": "Fictional service v2. POST /v2/jobs returns {id}. GET /v2/jobs/{id} reports status. DELETE /v2/jobs/{id} requests cancellation. Idempotency keys are not supported; retrying a submit can create a second job.\n", "src/app.mjs": "export const currentVersion='1';\n" },
    expected: { version: "2", submitPath: "/v2/jobs", pollPath: "/v2/jobs/{id}", cancelMethod: "DELETE", retrySubmit: false, citations: ["vendor-docs/v2.md"] } },
  { id: "investigate-tenant-key", question: "Inspect the cache and callers. Write docs/report.json with exactly: owner (path), callers (sorted path array), isolation ('safe' or 'unsafe'), cause (one of 'tenant-omitted', 'user-omitted', 'none'), remedy (one of 'include-tenant-and-user', 'increase-ttl', 'none'). Users can have the same id in different tenants. Do not modify code or invent runtime observations.",
    files: { "src/cache.mjs": "const values=new Map();\nexport const get=(tenant,user)=>values.get(user);\nexport const set=(tenant,user,value)=>values.set(user,value);\n", "src/profile.mjs": "import {get} from './cache.mjs';\nexport const profile=(ctx,user)=>get(ctx.tenant,user);\n", "src/update.mjs": "import {set} from './cache.mjs';\nexport const update=(ctx,user,value)=>set(ctx.tenant,user,value);\n" },
    expected: { owner: "src/cache.mjs", callers: ["src/profile.mjs", "src/update.mjs"], isolation: "unsafe", cause: "tenant-omitted", remedy: "include-tenant-and-user" } },
];

export const TERMINAL_WORKFLOW_CORPUS_VERSION = "terminal-workflows-v4";
export function terminalWorkflowCorpus(): TerminalCorpusTask[] {
  const common = (id: string) => ({ "package.json": JSON.stringify({ name: `workflow-${id}`, private: true, type: "module", scripts: { test: "node --test test/task.test.mjs" } }, null, 2) + "\n", "USER_NOTES.txt": `User-owned ${id} notes. Preserve byte for byte.\n` });
  const tasks: TerminalCorpusTask[] = coding.map(item => ({ id: item.id, family: "multi-file", variant: 1, split: "held-out",
    prompt: `${item.contract}\nExtend test/task.test.mjs with meaningful regression tests and run the suite. Only ${Object.keys(item.files).join(', ')} and test/task.test.mjs may change. Preserve all other files exactly. No new dependencies or unrelated features.`,
    files: { ...common(item.id), ...item.files, "test/task.test.mjs": `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/task.mjs';\ntest('public example',async()=>{${item.smoke}});\n` },
    allowedChanges: [...Object.keys(item.files), "test/task.test.mjs"], reference: item.reference, hiddenChecks: item.checks,
  }));
  for (const item of reports) {
    const expected = JSON.stringify(item.expected);
    // v2 corrects unstated v1 oracle assumptions without changing task prompts.
    // Research may also cite v1 for the comparison, while v2 remains mandatory.
    // v4 permits the duplicate-submit report to cite its two implementation
    // sources without an incident citation that the prompt never required.
    const normalize = item.id === "investigate-cache-expiry"
      ? "assert.ok(Array.isArray(report.evidence));report.evidence.sort();"
      : item.id === "research-pinned-upgrade"
        ? "assert.ok(Array.isArray(report.citations));assert.deepEqual(report.citations,[...new Set(report.citations)].sort());assert.ok(report.citations.includes('vendor-docs/v2.md'));assert.ok(report.citations.every(p=>['vendor-docs/v1.md','vendor-docs/v2.md'].includes(p)));report.citations=['vendor-docs/v2.md'];"
        : item.id === "investigate-duplicate-submit"
          ? "assert.ok(Array.isArray(report.evidence));assert.deepEqual(report.evidence,[...new Set(report.evidence)].sort());assert.ok(['src/client.mjs','src/server.mjs'].every(p=>report.evidence.includes(p)));assert.ok(report.evidence.every(p=>['docs/incident.md','src/client.mjs','src/server.mjs'].includes(p)));report.evidence=['docs/incident.md','src/client.mjs','src/server.mjs'];"
        : "";
    tasks.push({ id: item.id, family: item.id.startsWith("research") ? "pinned-document-research" : "repository-investigation", variant: 1, split: "held-out",
      prompt: `${item.question}\nOnly docs/report.json may be created or changed. Preserve every existing file, including tests and user notes, exactly. Run the existing tests; do not add tests or dependencies. This is investigation/report delivery, not implementation.`,
      files: { ...common(item.id), ...item.files, "test/task.test.mjs": `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {readFile} from 'node:fs/promises';\nconst read=async()=>JSON.parse(await readFile(new URL('../docs/report.json',import.meta.url),'utf8'));\ntest('report is an object',async()=>assert.equal(typeof await read(),'object'));\ntest('report is nonempty',async()=>assert.ok(Object.keys(await read()).length>0));\n` },
      allowedChanges: ["docs/report.json"], reference: { "docs/report.json": JSON.stringify(item.expected, null, 2) + "\n" },
      hiddenChecks: `const {readFile}=await import('node:fs/promises');\nconst report=JSON.parse(await readFile(new URL('./docs/report.json',import.meta.url),'utf8'));${normalize}assert.deepEqual(report,${expected});`,
      grading: { entrypoint: null, testFilesToExtend: [] },
    });
  }
  return tasks;
}

export const terminalWorkflowCorpusHash = (): string => createHash("sha256").update(JSON.stringify({ version: TERMINAL_WORKFLOW_CORPUS_VERSION, tasks: terminalWorkflowCorpus() })).digest("hex");
export const terminalWorkflowCorpusDefinition = () => ({ version: TERMINAL_WORKFLOW_CORPUS_VERSION, hash: terminalWorkflowCorpusHash(), tasks: terminalWorkflowCorpus(),
  limitations: ["12 distinct small workflows: eight multi-file implementations, three repository investigations, one research task over pinned fictional documents",
    "Pinned-document research does not qualify live web retrieval or citation quality", "Single-run outcomes are descriptive, not statistically powered model comparisons",
    "Does not qualify multi-hour recovery, media, physical resource admission or production coexistence"] });
