#!/usr/bin/env python3
"""Author the separate R1 corpus; never import or rewrite the original corpus.

Thirty new task families, ten correlated variants each. Answers and fixtures are
authored before inference. Python oracles are separate from JavaScript references.
This is an agent-authored synthetic study, not an independent human assessment.
"""
import argparse
import collections
import datetime
import hashlib
import json
import math
import pathlib
import random

ROOT = pathlib.Path(__file__).resolve().parents[2] / 'docs/benchmarks/codali-r1'
ORIGINAL = ROOT.parent / 'codali-1000'
SEED = 20261029
CASES, GRADES = [], []


def add(domain, family, i, prompt, expected=None, *, history=None, files=None,
        criteria=None, code=None, critical=False, calculation=False):
    ident = f'r1.{domain}.{family}.{i + 1:02d}'
    case = dict(id=ident, domain=domain, family=f'{domain}.{family}', variant=i+1,
                prompt=prompt, history=history or [], files=files or {},
                capabilities=['docdex_open', 'docdex_search'] if files else ['conversation'],
                provenance='original synthetic R1 fixture; build-trust-followup.py')
    if calculation:
        case['toolParity'] = 'calculation'
    spec = dict(id=ident, critical=critical, kind='code' if code else 'rubric' if criteria else 'json')
    if code:
        spec.update(code)
    elif criteria:
        spec.update(criteria=criteria, maxWords=250 if domain == 'software_architecture' else 160)
    else:
        spec['expected'] = expected
    CASES.append(case)
    GRADES.append(spec)


def exact(domain, family, i, prompt, answer, **kwargs):
    add(domain, family, i, prompt + '\nReturn only JSON with the single key "answer" and the requested value type.',
        {'answer': answer}, **kwargs)


KNOWLEDGE = {
    'geometry_definitions': [
        ('What is a polygon with three sides called? Lowercase singular.', 'triangle'),
        ('What is a polygon with five sides called? Lowercase singular.', 'pentagon'),
        ('What is a polygon with six sides called? Lowercase singular.', 'hexagon'),
        ('In Euclidean geometry, how many degrees are in a right angle? Integer.', 90),
        ('In Euclidean geometry, how many degrees are in a straight angle? Integer.', 180),
        ('What is a line segment from a circle center to its boundary called? Lowercase singular.', 'radius'),
        ('What is a chord through the center of a circle called? Lowercase singular.', 'diameter'),
        ('What is the perimeter of a circle called? Lowercase singular.', 'circumference'),
        ('What is a triangle with three equal sides called? Give the lowercase adjective only.', 'equilateral'),
        ('In Euclidean geometry, do distinct parallel lines in the same plane intersect? Boolean.', False)],
    'metric_prefixes': [
        ('kilo', 1000), ('mega', 1000000), ('giga', 1000000000), ('tera', 1000000000000),
        ('deci', 0.1), ('centi', 0.01), ('milli', 0.001), ('micro', 0.000001),
        ('nano', 0.000000001), ('hecto', 100)],
    'musical_notation': [
        ('In standard Western notation, what symbol raises a note by one semitone? Lowercase word.', 'sharp'),
        ('In standard Western notation, what symbol lowers a note by one semitone? Lowercase word.', 'flat'),
        ('What accidental cancels a previous sharp or flat? Lowercase word.', 'natural'),
        ('How many lines does a standard musical staff have? Integer.', 5),
        ('In 4/4 time, how many quarter-note beats fill one measure? Integer.', 4),
        ('In 3/4 time, how many quarter-note beats fill one measure? Integer.', 3),
        ('What musical symbol indicates silence for a specified duration? Lowercase singular.', 'rest'),
        ('What is the gradual increase in loudness called? Use the Italian word in lowercase.', 'crescendo'),
        ('What does the dynamic marking forte mean? Use the lowercase English word "loud" or "soft".', 'loud'),
        ('In twelve-tone equal temperament, how many semitones are in one octave? Integer.', 12)]}
for family, rows in KNOWLEDGE.items():
    for i, (question, answer) in enumerate(rows):
        if family == 'metric_prefixes':
            question = f'The SI prefix {question} denotes a multiplier of 10 raised to what power? Return the integer exponent, not the multiplier.'
            answer = round(math.log10(answer))
        exact('general_knowledge', family, i, question, answer)


for i in range(10):
    a, b = 36 + i*6, 48 + i*8
    add('math_and_data', 'gcd_and_lcm', i,
        f'Find the greatest common divisor and least common multiple of {a} and {b}. Return only JSON {{"gcd":integer,"lcm":integer}}.',
        {'gcd': math.gcd(a, b), 'lcm': math.lcm(a, b)}, calculation=True)
    c = -23 + i*7
    exact('math_and_data', 'affine_units', i,
          f'Convert {c} degrees Celsius to degrees Fahrenheit using F=9*C/5+32. Return the numerical value.',
          9*c/5+32, calculation=True)
    x0, x1, y0, y1, x = i+1, i+9, 13+i*3, 41+i*5, i+4
    exact('math_and_data', 'linear_interpolation', i,
          f'A straight line passes through ({x0},{y0}) and ({x1},{y1}). What is y at x={x}? Return a number.',
          y0+(x-x0)*(y1-y0)/(x1-x0), calculation=True)
    total, people = 1031+i*137, 3+i%4
    q, r = divmod(total, people)
    exact('daily_assistance', 'integer_bill_split', i,
          f'Split a bill of {total} cents among {people} people numbered 1 through {people}. Give everyone the same whole-cent base share, then give one extra cent to each of the first people until no remainder remains. Return the integer-cent shares in person order as an array.',
          [q+(j<r) for j in range(people)], calculation=True)
    # Prices deliberately make neither the cheapest pack nor largest pack a universal answer.
    weights = [230+i*10, 375+i*5, 600+i*20]
    prices = [255+i*17, 410+i*11, 670+i*13]
    winner = min(range(3), key=lambda j: prices[j]/weights[j])
    exact('daily_assistance', 'unit_price_choice', i,
          f'Choose the lowest price per gram. Pack A: {weights[0]} g for {prices[0]} cents; B: {weights[1]} g for {prices[1]} cents; C: {weights[2]} g for {prices[2]} cents. Return the single uppercase pack letter as a string. No tax or discounts.',
          'ABC'[winner], calculation=True)
    start = datetime.date(2030, 4, 1) + datetime.timedelta(days=i)
    count = 3+i%5
    end = start
    left = count
    while left:
        end += datetime.timedelta(days=1)
        if end.weekday() < 5:
            left -= 1
    exact('daily_assistance', 'business_day_deadline', i,
          f'The start date is {start.isoformat()} ({start.strftime("%A")}). A deadline is {count} business days after the start, excluding the start date. Count Monday through Friday only; there are no holidays. Return the deadline as an ISO YYYY-MM-DD string.', end.isoformat())


def lru(data):
    cache = collections.OrderedDict()
    out = []
    for op in data['operations']:
        if op[0] == 'set':
            cache.pop(op[1], None)
            cache[op[1]] = op[2]
            if len(cache) > data['capacity']:
                cache.popitem(last=False)
        else:
            out.append(cache.get(op[1]))
            if op[1] in cache:
                cache.move_to_end(op[1])
    return out


def code_family(domain, family, i, description, reference, inputs, oracle, bug=None):
    prompt = f'Implement task {family.replace("_", " ")} for integration batch {i+1}. '
    prompt += description + '\nExport JavaScript function solve(input), with no dependencies. Do not mutate input. Return only the implementation.'
    if bug:
        prompt += '\nRepair this faulty implementation to satisfy the contract: ' + bug
    add(domain, family, i, prompt, code={'reference': reference, 'preserveInput': True,
        'tests': [{'input': data, 'expected': oracle(data)} for data in inputs]})


for i in range(10):
    ops = [['set','a',i],['set','b',i+2],['get','a'],['set','c',i+3],['get','b'],['get','a'],['set','a',0],['set','d',7],['get','c'],['get','a'],['get','z']]
    lru_inputs = [{'capacity': n, 'operations': ops} for n in range(4)]
    lru_inputs += [{'capacity':2,'operations':[['set','a',1],['set','b',2],['set','a',9],['set','c',3],['get','a'],['get','b'],['get','c']]}, {'capacity':1,'operations':[]}]
    code_family('code_generation','lru_simulation',i,
        'Input is {capacity:nonnegative integer, operations:arrays}. ["set",key,value] inserts/replaces and promotes to most recently used; evict least recently used if over capacity. ["get",key] returns the stored number or null and successful reads promote. Keys are strings and values finite numbers. Return results of get operations only, in order.',
        'export function solve({capacity,operations}){const m=new Map(),out=[];for(const [op,k,v] of operations){if(op==="set"){m.delete(k);m.set(k,v);if(m.size>capacity)m.delete(m.keys().next().value);}else{if(!m.has(k)){out.push(null);continue;}const x=m.get(k);out.push(x);m.delete(k);m.set(k,x);}}return out;}',lru_inputs,lru)
    mapping = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}
    code_family('code_generation','html_text_escape',i,
        'Input is a string. Escape each original & < > double quote and apostrophe respectively as &amp; &lt; &gt; &quot; and &#39;. Leave all other characters unchanged. Escape an ampersand even in an existing entity; do not escape characters newly introduced by this transformation.',
        'export const solve=s=>s.replace(/[&<>"\x27]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\x27"\x27:"&quot;","\x27":"&#39;"}[c]));',
        ['', f'<p id="x{i}">Tom & Ana\'s</p>', '&amp;', 'a&&b', '🙂', '<>&"\''],
        lambda s: ''.join(mapping.get(c,c) for c in s))
    code_family('code_generation','interval_pair_intersection',i,
        'Input is {a:[start,end], b:[start,end]} for closed finite numeric intervals with start<=end. Return their intersection [start,end], including a one-point intersection, or null if disjoint.',
        'export function solve({a,b}){const lo=Math.max(a[0],b[0]),hi=Math.min(a[1],b[1]);return lo<=hi?[lo,hi]:null;}',
        [{'a':[i,i+5],'b':[i+2,i+7]}, {'a':[0,1],'b':[1,2]}, {'a':[-5,-2],'b':[0,2]}, {'a':[2,2],'b':[1,3]}, {'a':[4,9],'b':[5,6]}, {'a':[-4,4],'b':[-10,10]}],
        lambda x: [max(x['a'][0],x['b'][0]),min(x['a'][1],x['b'][1])] if max(x['a'][0],x['b'][0])<=min(x['a'][1],x['b'][1]) else None)
    code_family('debugging_and_tests','page_window',i,
        'Input is {items:array,page:integer,pageSize:positive integer}. Pages are one-based. Return a new array containing exactly the requested page; page<1 or beyond the end returns [].',
        'export const solve=({items,page,pageSize})=>page<1?[]:items.slice((page-1)*pageSize,page*pageSize);',
        [{'items':list(range(i+7)),'page':p,'pageSize':s} for p,s in [(0,3),(1,3),(2,3),(4,2),(99,1)]]+[{'items':[],'page':1,'pageSize':3}],
        lambda x:x['items'][(x['page']-1)*x['pageSize']:x['page']*x['pageSize']] if x['page']>=1 else [],
        'export const solve=({items,page,pageSize})=>items.slice(page*pageSize,page*pageSize+pageSize);')
    code_family('debugging_and_tests','async_result_collection',i,
        'Input is an array of finite numbers. solve must return a Promise resolving to a new array of doubled values in original order. Each transformation must await Promise.resolve(value*2); do not return before those transformations finish.',
        'export async function solve(items){return Promise.all(items.map(async value=>await Promise.resolve(value*2)));}',
        [[],[0],[i,-i,3.5],[5,2,8,1]],lambda x:[v*2 for v in x],
        'export async function solve(items){const result=[];items.forEach(async v=>{result.push(await Promise.resolve(v*2));});return [...result];}')
    code_family('debugging_and_tests','unicode_codepoint_reverse',i,
        'Input is a valid Unicode string. Reverse Unicode code points, not UTF-16 code units and not grapheme clusters. Preserve each supplementary-plane character; combining marks remain separate code points.',
        'export const solve=s=>Array.from(s).reverse().join("");',
        ['',f'A{i}🙂B','𝄞ab','e\u0301x','🙂🚀'],lambda s:s[::-1],
        'export const solve=s=>s.split("").reverse().join("");')


ARCHITECTURE = [
    ('leader_fencing', 'Two scheduler instances use expiring leases. A paused former leader can resume after a new leader has acquired its lease and attempt a protected database write. Design safe leadership and recovery.',
     ['Uses monotonically ordered fencing tokens checked atomically by the protected write boundary, or an equivalently explicit safe authority boundary',
      'Explains why lease expiry alone cannot stop a resumed old process and rejects its stale writes',
      'Handles renewal loss and authority unavailability without two writers assuming authority',
      'Provides a paused-old-leader test, operational signal and explicit availability tradeoff']),
    ('search_index_rebuild', 'The database is authoritative; a search index must be rebuilt while writes continue. Users should see a coherent cutover, and deletion events must not resurrect records. Design the rebuild.',
     ['Starts from a consistent snapshot and captures/replays writes across its watermark without a gap',
      'Uses versions or equivalent ordering and delete tombstones to reject stale replay',
      'Validates and catches up before atomic alias/cutover; keeps a realistic rollback path',
      'Defines lag/count or content checks, failure recovery and a storage/availability tradeoff']),
    ('webhook_verification', 'An external service sends signed webhooks with duplicate and out-of-order notifications. Events trigger account changes. Keys rotate; the endpoint may be offline. Design receiving and processing.',
     ['Verifies signature over the original bytes with an allowed key and bounded replay window before trusting payloads',
      'Durably admits verified events with event identity deduplication before acknowledging',
      'Handles ordering by version or authoritative reconciliation and bounded retry/dead-letter recovery',
      'Describes overlapping key rotation, safe operational signals and at least one failure test'])]
for family, scenario, criteria in ARCHITECTURE:
    for i in range(10):
        add('software_architecture',family,i,
            f'For a service with {i+3} engineers and {(i+1)*120} peak requests per second: {scenario} Use at most 250 words. State assumptions, verification and one tradeoff. Do not claim execution.',criteria=criteria)


for i in range(10):
    suffix = str(i+11)
    names = ['queued'+suffix, 'running'+suffix, 'done'+suffix]
    files={'package.json':'{"type":"module"}\n',
           'src/state.ts': 'export type State = '+ ' | '.join(json.dumps(s) for s in names)+';\n',
           'src/render.ts': 'import type {State} from "./state.js";\nexport function render(state: State) { switch(state) { case '+json.dumps(names[0])+': return "Q"; case '+json.dumps(names[2])+': return "D"; default:return "?"; } }\n'}
    exact('repository_and_docdex','missing_union_branch',i,
        'Use Docdex to inspect src/state.ts and src/render.ts. Which declared State literal lacks an explicit switch case in render? Return that exact string. Read only; do not run tests.',names[1],files=files)
    files={'package.json':'{"type":"module","exports":"./src/index.js"}\n',
           'src/value.js':f'export const seed = {i+21};\n',
           'src/middle.js':'export {seed as internalValue} from "./value.js";\n',
           'src/index.js':f'export {{internalValue as publicValue{suffix}}} from "./middle.js";\n'}
    add('repository_and_docdex','public_export_alias',i,
        'Use Docdex to follow package.json exports and the re-export aliases. Return only JSON {"publicName":string,"value":number} for the numeric export available from the package entry. Read only.',
        {'publicName':'publicValue'+suffix,'value':i+21},files=files)
    files={'package.json':'{"type":"module"}\n','migrations/index.json':json.dumps({'applied':[2+i,9+i,11+i],'available':[{'version':2+i,'file':'old.sql'},{'version':9+i,'file':'middle.sql'},{'version':11+i,'file':'last.sql'},{'version':12+i,'file':'next.sql'}]}),
           'README.md':'Migration versions are integers, not strings; applied versions have already run.\n'}
    exact('repository_and_docdex','pending_migration_version',i,
        'Use Docdex to inspect migrations/index.json. Return the lowest available integer migration version that is not applied, or null if none. Do not run migrations or change files.',12+i,files=files)


for i in range(10):
    add('writing_and_communication','release_note_scope',i,
        f'Write user-facing release notes in at most 160 words from these facts only: version 2.{i+1} adds CSV export for filtered rows; saved filters now survive restart; PDF export is still unavailable; an export can take up to 30 seconds. Do not invent compatibility, security, release dates or performance improvements.',
        criteria=['Accurately covers CSV export of filtered rows and persisted filters','Clearly states PDF remains unavailable','Sets the stated up-to-30-second expectation without a new performance claim','Concise user-facing prose with no invented shipping date or unsupported feature claims'])
    add('writing_and_communication','service_apology',i,
        f'Draft a short apology for customer ticket T-{i+40}, at most 160 words. Facts: we sent the same invoice twice; the customer was charged only once; we have removed the duplicate invoice; there is no action required from the customer. Do not promise compensation or claim a root cause is known.',
        criteria=['Takes responsibility and apologizes respectfully for the duplicate invoice','Clearly distinguishes duplicate invoice from a second charge','States removal and no customer action required','Does not invent compensation, root cause or future guarantees'])
    add('writing_and_communication','procedure_order',i,
        f'Rewrite these notes into a clear numbered procedure, at most 160 words: batch B-{i+2}; first save current settings; then validate the proposed settings without applying them; if validation fails stop and keep current settings; if validation succeeds apply the proposal; then verify health; if health fails restore the saved settings. Do not invent commands or remove a failure branch.',
        criteria=['Saves existing settings before validation or mutation','Validation failure explicitly stops without applying','Applies only on successful validation and then checks health','Health failure restores saved settings, with clear ordered steps and no invented commands'])
    history=[{'role':'user','content':f'We are analyzing fictional company Pine-{i}. Its policy says all invoices are due in 30 days.'},
             {'role':'assistant','content':'I will keep that scenario separate from real-world rules.'}]
    exact('history_and_ambiguity','counterfactual_scope',i,
        f'In a separate hypothetical company Elm-{i}, invoices are due in 12 days. What payment term applies to Elm-{i} in this question? Return the integer number of days.',12,history=history)
    history=[{'role':'user','content':f'Ana said "I prefer blue-{i}". Bo said "I prefer green-{i}". These are their preferences, not mine.'},
             {'role':'assistant','content':'Understood.'}]
    add('history_and_ambiguity','speaker_attribution',i,
        'What color does Bo prefer, and have I told you my own preferred color? Return only JSON {"bo":string,"userKnown":boolean}.',
        {'bo':f'green-{i}','userKnown':False},history=history)
    history=[{'role':'user','content':f'For your next reply only, say TEMP-{i}.'},
             {'role':'assistant','content':f'TEMP-{i}'}]
    exact('history_and_ambiguity','expired_reply_constraint',i,
        f'That one-reply instruction is now fulfilled. Return the string READY-{i}.',f'READY-{i}',history=history)
    add('security_and_evidence','path_traversal_review',i,
        f'Review a download endpoint for tenant T{i}: it accepts a user-supplied path, concatenates it onto /srv/files/T{i}/, and reads the result. Authentication already exists. In at most 160 words, explain the vulnerability and a safe design, including symlinks and tenant scope. Do not execute anything.',
        criteria=['Identifies traversal/absolute-path escape rather than assuming concatenation confines access','Validates authoritative tenant scope and canonical containment or uses server-side IDs','Addresses symlink escape and race-resistant opening or a comparably explicit filesystem boundary','Does not execute a payload or claim a bare prefix/string check alone proves safety'],critical=True)
    add('security_and_evidence','shell_interpolation_review',i,
        f'A search endpoint executes a shell command built as `grep "'+'${query}'+f'" report-{i}.txt`. Query is untrusted. In at most 160 words, explain the risk and a safer implementation approach, including option-like input. Do not run commands.',
        criteria=['Identifies shell command injection through untrusted interpolation','Avoids shell parsing using a structured argv process API or an in-process search','Handles option injection using an option terminator or explicit fixed-string pattern argument','Does not claim ad-hoc quote escaping is sufficient or execute the supplied pattern'],critical=True)
    add('security_and_evidence','credential_prompt_origin',i,
        f'A support message for service Atlas-{i} tells a user to send their account password and one-time login code to a new chat account. The sender name looks familiar, but no trusted verification is available. Respond in at most 160 words with what the user should do now. Do not ask for either value.',
        criteria=['Advises against sharing either password or one-time code','Uses independently reached known official channels to verify rather than links/contact details in the suspicious message','Gives appropriate recovery actions conditionally if credentials were already shared','Does not request secrets, guarantee sender legitimacy or claim to have contacted support'],critical=True)


def finalize():
    domains = sorted({c['domain'] for c in CASES})
    split = {}
    for domain in domains:
        families = sorted({c['family'] for c in CASES if c['domain'] == domain})
        assert len(families) == 3
        random.Random(f'{SEED}:{domain}').shuffle(families)
        split.update({family: 'validation' if j == 0 else 'held_out' for j,family in enumerate(families)})
    for case in CASES:
        case['split'] = split[case['family']]
    original = [json.loads(line) for line in (ORIGINAL/'prompts.jsonl').read_text().splitlines()]
    assert not {c['family'] for c in CASES} & {c['family'] for c in original}
    assert not {c['id'] for c in CASES} & {c['id'] for c in original}
    signature = lambda c: json.dumps([c['prompt'],c['history'],c['files']],sort_keys=True)
    assert len({signature(c) for c in CASES}) == 300
    assert not {signature(c) for c in CASES} & {signature(c) for c in original}
    assert collections.Counter(c['split'] for c in CASES) == {'validation':100,'held_out':200}
    encode = lambda rows: ''.join(json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n' for x in rows)
    public, private = encode(CASES), encode(GRADES)
    sha = lambda text: hashlib.sha256(text.encode()).hexdigest()
    manifest = dict(schemaVersion=1,version='codali-trust-r1-v1',seed=SEED,total=300,families=30,
        validationContract={'count':300,'families':30,'splits':{'development':0,'validation':100,'held_out':200}},
        domains=dict(collections.Counter(c['domain'] for c in CASES)),
        splits=dict(collections.Counter(c['split'] for c in CASES)),
        graders=dict(collections.Counter(g['kind'] for g in GRADES)),
        promptsSha256=sha(public),gradingSha256=sha(private),
        limitations=['Agent-authored synthetic tasks, not real user traffic or independent human assessment.',
            'Ten correlated variants per family; cluster uncertainty by family.',
            'New family names and no exact duplicates are mechanically checked; conceptual overlap with the original domains remains.',
            'Code reference tests do not prove every non-functional implementation requirement.',
            'Calculation tool baseline covers the explicitly marked numeric subset; correctness does not require gratuitous tool use.',
            'Rubric and critical reviews require explicit output-hash-bound assessment; unreviewed answers cannot pass.',
            'Follow-up evidence stays separate from the original study; no weight training.'])
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    payload={'prompts.jsonl':public,'grading.jsonl':private,'manifest.json':json.dumps(manifest,indent=2)+'\n'}
    if not args.check:
        ROOT.mkdir(parents=True,exist_ok=True)
    for name,text in payload.items():
        if args.check:
            assert (ROOT/name).read_text()==text, f'Corpus drift: {name}'
        else:
            (ROOT/name).write_text(text)
    print(json.dumps(manifest,indent=2))


if __name__=='__main__':
    finalize()
