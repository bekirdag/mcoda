// Independent prospective API checks. Run only against disposable evaluation copies.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const [kind,base]=process.argv.slice(2);
if(!['custody','workshop'].includes(kind)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base??''))throw Error('Use custody|workshop and local HTTP URL');
const checks=[];const cookies=new Map();let shared={};
async function call(method,url,body,who='admin',extra={}){
 const r=await fetch(base+url,{method,headers:{...(body?{'content-type':'application/json'}:{}),origin:base,...(cookies.has(who)?{cookie:cookies.get(who)}:{}),...extra},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
 const set=r.headers.getSetCookie();if(set.length)cookies.set(who,set.map(x=>x.split(';')[0]).join('; '));
 const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return{status:r.status,data,text,headers:Object.fromEntries(r.headers)};
}
const good=r=>{assert.ok(r.status>=200&&r.status<300,`HTTP${r.status}: ${r.text.slice(0,200)}`);return r.data;};
const entity=d=>{assert.ok(d&&d.id,'API must return entity with id');return d.id;};
const prerequisite=(id)=>assert.ok(checks.some(c=>c.id===id&&c.status==='pass'),`Prerequisite ${id} did not pass; this negative check cannot establish protection`);
const check=async(id,fn)=>{try{await fn();checks.push({id,status:'pass'});}catch(e){checks.push({id,status:'fail',error:String(e)});}};
await check('health',async()=>assert.equal(good(await call('GET','/health')).ok,true));
await check('unauthenticated',async()=>assert.equal((await call('GET','/api/me',undefined,'anonymous')).status,401));
const first=kind==='custody'?'north':'birch',second=kind==='custody'?'south':'pine';
const privileged=kind==='custody'?'admin':'manager',low=kind==='custody'?'viewer':'member';
for(const [who,email]of [['admin',`${privileged}@${first}.test`],['other',`${privileged}@${second}.test`],['viewer',`${low}@${first}.test`]]) await check('login-'+who,async()=>{good(await call('POST','/api/login',{email,password:'Demo-Forest-731!'},who));assert.ok(cookies.get(who));good(await call('GET','/api/me',undefined,who));});
await check('wrong-password',async()=>assert.ok([400,401].includes((await call('POST','/api/login',{email:`${privileged}@${first}.test`,password:'wrong'},'bad')).status)));
if(kind==='custody'){
 const make=()=>({reference:'VERIFY-'+randomUUID(),origin:'Lab',destination:'Depot',minTemperature:20,maxTemperature:80});
 await check('create-shipment',async()=>{shared.shipment=entity(good(await call('POST','/api/shipments',make())));});
 await check('invalid-temperature-range',async()=>assert.equal((await call('POST','/api/shipments',{...make(),minTemperature:90,maxTemperature:10})).status,400));
 await check('viewer-cannot-create',async()=>assert.equal((await call('POST','/api/shipments',make(),'viewer')).status,403));
 await check('cross-tenant-read',async()=>{prerequisite('login-other');prerequisite('create-shipment');good(await call('GET',`/api/shipments/${shared.shipment}`));assert.equal((await call('GET',`/api/shipments/${shared.shipment}`,undefined,'other')).status,404);});
 await check('cross-tenant-write',async()=>{prerequisite('cross-tenant-read');assert.equal((await call('POST',`/api/shipments/${shared.shipment}/transitions`,{status:'in_transit',location:'Depot'},'other')).status,404);});
 await check('transition-reject-skip',async()=>assert.ok([400,409].includes((await call('POST',`/api/shipments/${shared.shipment}/transitions`,{status:'delivered',location:'Depot'})).status)));
 await check('transition-forward',async()=>{good(await call('POST',`/api/shipments/${shared.shipment}/transitions`,{status:'in_transit',location:'Depot'}));good(await call('POST',`/api/shipments/${shared.shipment}/transitions`,{status:'delivered',location:'Lab'}));});
 const readings=[{eventId:'d',timestamp:'2033-01-02T00:03:00Z',temperature:80},{eventId:'b',timestamp:'2033-01-02T00:01:00Z',temperature:10},{eventId:'a',timestamp:'2033-01-02T00:00:00Z',temperature:50},{eventId:'c',timestamp:'2033-01-02T00:02:00Z',temperature:90}];
 await check('reading-import-idempotence',async()=>{const shipment=entity(good(await call('POST','/api/shipments',make())));shared.readingShipment=shipment;good(await call('POST',`/api/shipments/${shipment}/readings`,{readings}));good(await call('POST',`/api/shipments/${shipment}/readings`,{readings}));assert.equal(good(await call('GET',`/api/shipments/${shipment}/readings`)).items.length,4);});
 await check('reading-conflict-atomic',async()=>{const url=`/api/shipments/${shared.readingShipment}/readings`;assert.equal((await call('POST',url,{readings:[{eventId:'new',timestamp:'2033-01-02T00:04:00Z',temperature:50},{...readings[0],temperature:999}]})).status,409);assert.equal(good(await call('GET',url)).items.length,4);});
 await check('excursion-order-and-boundary',async()=>{const xs=good(await call('GET',`/api/shipments/${shared.readingShipment}/excursions`)).items;assert.equal(xs.length,1);assert.equal(xs[0].sampleCount,2);assert.equal(xs[0].maxDeviation,10);assert.equal(Date.parse(xs[0].start),Date.parse('2033-01-02T00:01:00Z'));assert.equal(Date.parse(xs[0].end),Date.parse('2033-01-02T00:02:00Z'));});
 await check('export-no-cross-tenant-leak',async()=>{const r=await call('GET','/api/shipments/export.csv');good(r);assert.ok(!r.text.includes('SOUTH-ONLY'));assert.ok(!/password|session_token/i.test(r.text));});
}else{
 await check('create-resource',async()=>{shared.resource=entity(good(await call('POST','/api/resources',{name:'Verify-'+randomUUID(),capacity:2})));});
 await check('member-cannot-create-resource',async()=>assert.equal((await call('POST','/api/resources',{name:'Forbidden',capacity:2},'viewer')).status,403));
 await check('cross-tenant-resource',async()=>{prerequisite('login-other');prerequisite('create-resource');good(await call('GET',`/api/resources/${shared.resource}`));assert.equal((await call('GET',`/api/resources/${shared.resource}`,undefined,'other')).status,404);});
 const booking=(start='10:00',end='11:00',seats=1)=>({resourceId:shared.resource,start:`2033-01-02T${start}:00Z`,end:`2033-01-02T${end}:00Z`,seats,purpose:'Verification'});
 await check('booking-idempotence',async()=>{const key=randomUUID(),body=booking();const a=good(await call('POST','/api/bookings',body,'viewer',{'Idempotency-Key':key}));shared.booking=entity(a);assert.equal(entity(good(await call('POST','/api/bookings',body,'viewer',{'Idempotency-Key':key}))),shared.booking);assert.equal((await call('POST','/api/bookings',{...body,purpose:'changed'},'viewer',{'Idempotency-Key':key})).status,409);});
 await check('concurrent-capacity',async()=>{const rs=await Promise.all([1,2].map(()=>call('POST','/api/bookings',booking(),'viewer',{'Idempotency-Key':randomUUID()})));assert.equal(rs.filter(r=>r.status>=200&&r.status<300).length,1);assert.equal(rs.filter(r=>r.status===409).length,1);});
 await check('half-open-adjacency',async()=>good(await call('POST','/api/bookings',booking('11:00','12:00',2),'viewer',{'Idempotency-Key':randomUUID()})));
 await check('invalid-interval',async()=>assert.equal((await call('POST','/api/bookings',booking('12:00','11:00'),'viewer',{'Idempotency-Key':randomUUID()})).status,400));
 await check('cross-tenant-booking',async()=>{prerequisite('cross-tenant-resource');prerequisite('booking-idempotence');assert.equal((await call('POST','/api/bookings',booking('13:00','14:00'),'other',{'Idempotency-Key':randomUUID()})).status,404);});
 await check('maintenance-overlap-rejected',async()=>assert.equal((await call('POST','/api/maintenance',{resourceId:shared.resource,start:'2033-01-02T10:30:00Z',end:'2033-01-02T11:30:00Z',note:'service'})).status,409));
 await check('maintenance-blocks-booking',async()=>{good(await call('POST','/api/maintenance',{resourceId:shared.resource,start:'2033-01-02T14:00:00Z',end:'2033-01-02T15:00:00Z',note:'service'}));assert.equal((await call('POST','/api/bookings',booking('14:00','15:00'),'viewer',{'Idempotency-Key':randomUUID()})).status,409);});
 await check('cancel-releases-capacity',async()=>{good(await call('POST',`/api/bookings/${shared.booking}/cancel`,{note:'cancel own'},'viewer'));good(await call('POST','/api/bookings',booking(),'viewer',{'Idempotency-Key':randomUUID()}));});
 await check('stock-idempotence-and-negative',async()=>{const id=entity(good(await call('POST','/api/inventory/items',{name:'Bolt-'+randomUUID()})));shared.item=id;const url=`/api/inventory/items/${id}/movements`,body={movementId:randomUUID(),quantity:5,note:'receive'};good(await call('POST',url,body));good(await call('POST',url,body));assert.equal((await call('POST',url,{...body,quantity:6})).status,409);assert.ok([400,409].includes((await call('POST',url,{movementId:randomUUID(),quantity:-6,note:'bad'})).status));assert.equal(good(await call('GET','/api/inventory/items')).items.find(x=>x.id===id).quantity,5);});
 await check('member-cannot-adjust-stock',async()=>assert.equal((await call('POST',`/api/inventory/items/${shared.item}/movements`,{movementId:randomUUID(),quantity:1,note:'bad'},'viewer')).status,403));
}
await check('logout-invalidates-session',async()=>{const cookie=cookies.get('viewer');good(await call('POST','/api/logout',{},'viewer'));cookies.set('viewer',cookie);assert.equal((await call('GET','/api/me',undefined,'viewer')).status,401);});
console.log(JSON.stringify({kind,base,checks,passed:checks.filter(c=>c.status==='pass').length,total:checks.length},null,2));
