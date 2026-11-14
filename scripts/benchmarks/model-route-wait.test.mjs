import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModelDispatch, waitForModelRoute } from './model-route-wait.mjs';

test('a refused dispatch keeps the study waiting even when discovery would pass', async () => {
  const events=[]; let calls=0;
  const provider={generate:async()=>{if(++calls<3)throw Error('HTTP 409: capacity_busy');return {message:{content:'READY'}};}};
  const signal=new AbortController().signal;
  await waitForModelRoute({signal,probe:s=>probeModelDispatch(provider,s),sleep:async()=>{},onState:async e=>events.push(e.type)});
  assert.equal(calls,3);
  assert.deepEqual(events,['model_route_wait','model_route_ready']);
});
test('dispatch probe is small and carries cancellation', async () => {
  const controller=new AbortController(), reason=Error('cancelled');let request;
  await probeModelDispatch({generate:async r=>{request=r;}},controller.signal);
  assert.equal(request.maxTokens,64);
  controller.abort(reason);
  assert.equal(request.signal.aborted,true);
  assert.equal(request.signal.reason,reason);
});

test('repeated unavailable discovery waits without creating an attempt', async () => {
  const events=[]; let calls=0, pauses=0;
  await waitForModelRoute({signal:new AbortController().signal,
    probe:async()=>{if(++calls<4)throw Error('unavailable');},
    sleep:async()=>{pauses++;},onState:async event=>events.push(event.type)});
  assert.equal(calls,4);assert.equal(pauses,3);
  assert.deepEqual(events,['model_route_wait','model_route_ready']);
});
test('initially healthy route does not wait', async () => {
  await waitForModelRoute({signal:new AbortController().signal,probe:async()=>{},
    sleep:async()=>assert.fail('unexpected wait'),onState:async()=>assert.fail('unexpected event')});
});
test('abort during discovery is propagated without retry', async () => {
  const controller=new AbortController(), reason=Error('cancelled');
  await assert.rejects(waitForModelRoute({signal:controller.signal,
    probe:async()=>{controller.abort(reason);throw Error('transport error');},
    sleep:async()=>assert.fail('unexpected retry'),onState:async()=>assert.fail('unexpected event')}),e=>e===reason);
});
test('recovery ledger failure is never swallowed as a discovery outage', async () => {
  let calls=0;const reason=Error('ledger failed');
  await assert.rejects(waitForModelRoute({signal:new AbortController().signal,
    probe:async()=>{if(++calls===1)throw Error('unavailable');},sleep:async()=>{},
    onState:async event=>{if(event.type==='model_route_ready')throw reason;}}),e=>e===reason);
  assert.equal(calls,2);
});
