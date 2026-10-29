import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeCodeCompatibility, observeCode } from './analyze-trust-code-compatibility.mjs';

const spec = { kind: 'code', preserveInput: true, tests: [{ input: [1, 2], expected: [2, 4] }, { input: [], expected: [] }] };

test('secondary diagnostic executes unchanged named/default ESM and CommonJS exports', async () => {
  for (const source of [
    'export const solve=xs=>xs.map(x=>x*2);',
    'export default function solve(xs){return xs.map(x=>x*2);}',
    'module.exports=function solve(xs){return xs.map(x=>x*2);};',
    'exports.solve=xs=>xs.map(x=>x*2);',
  ]) assert.equal((await gradeCodeCompatibility(spec, source)).passed, true, source);
});

test('wrong results, mutation and thrown errors cannot become compatible passes', async () => {
  assert.equal((await gradeCodeCompatibility(spec, 'module.exports=xs=>xs;')).passed, false);
  assert.equal((await gradeCodeCompatibility(spec, 'module.exports=xs=>{for(let i=0;i<xs.length;i++)xs[i]*=2;return xs;};')).passed, false);
  const nullSpec = { kind: 'code', tests: [{ input: 1, expected: null }] };
  assert.equal((await gradeCodeCompatibility(nullSpec, 'module.exports=()=>{throw Error("no answer");};')).passed, false);
});

test('observer rejects ambiguous source and unsupported probes and enforces sandbox boundary', async () => {
  assert.equal((await gradeCodeCompatibility(spec, '```js\nexport const solve=()=>[];\n```\n```js\nexport const solve=()=>[];\n```')).passed, false);
  await assert.rejects(observeCode('x', [1], '.js'), /extension/);
  await assert.rejects(gradeCodeCompatibility({ ...spec, complexityProbe: {} }, 'x'), /Unsupported/);
  const attack = 'module.exports=()=>require("node:fs").readFileSync("/etc/passwd","utf8");';
  await assert.rejects(observeCode(attack, [1], '.cjs'));
});
