import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { fullTrustTools } from './trust-full-tools.mjs';
import { hasToolBaseline } from './trust-common.mjs';
import { ToolRegistry } from '../../packages/codali/dist/tools/ToolRegistry.js';
test('full direct-tool baseline is lazy and grants the same compute/evidence capabilities',async()=>{
  const registry=new ToolRegistry();let starts=0;
  const exposed=fullTrustTools(registry,os.tmpdir(),async()=>{starts++;throw Error('not needed');});
  assert.equal(starts,0);assert.equal(hasToolBaseline({domain:'general',toolParity:'full'}),true);
  for(const name of ['decimal_calculate','symbolic_math','solve_constraints','query_data','transform_data','validate_json','verify_javascript','verify_tests','extract_entities','server_time','browser_open','document_read','docdex_batch_search','docdex_kg_search_nodes'])assert.ok(registry.list().some(tool=>tool.name===name),name);
  assert.ok(!registry.list().some(tool=>tool.name==='docdex_kg_clear'));
  assert.ok(!registry.list().some(tool=>tool.name==='document_create'));
  const result=await registry.execute('tools_describe',{names:['decimal_calculate','verify_tests']},{workspaceRoot:os.tmpdir()});
  assert.equal(result.ok,true);assert.ok(exposed.has('decimal_calculate'));assert.ok(exposed.has('verify_tests'));assert.equal(starts,0);
});
test('raw tools use the same configured initial schema exposure',()=>{
  const registry=new ToolRegistry();
  const exposed=fullTrustTools(registry,os.tmpdir(),async()=>{throw Error('not needed');},[]);
  assert.deepEqual([...exposed],['tools_describe']);
  assert.throws(()=>fullTrustTools(new ToolRegistry(),os.tmpdir(),async()=>{},['write_file']),/unavailable read-only tool/);
});
