import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStudyShape, studyLabels } from './study-shape.mjs';

test('two-arm studies cannot accidentally schedule a historical Codali arm', () => {
  assert.deepEqual(studyLabels({comparisonArms:['after','raw_tools']}),['after','raw_tools']);
  assert.deepEqual(studyLabels({}),['before','after','raw_tools']);
  for(const labels of [null,[],['raw_tools'],['after','after'],['after','unknown']]) assert.throws(()=>studyLabels({comparisonArms:labels}));
});

test('historical cohorts still require fifty questions and two builds', () => {
  const cases = Array.from({length:52}, (_,i)=>({id:String(i),comparison:i<50?'answer':'implementation'}));
  assert.doesNotThrow(()=>validateStudyShape({},cases));
  assert.throws(()=>validateStudyShape({},cases.slice(0,51)));
  assert.throws(()=>validateStudyShape({},cases.map(c=>({...c,comparison:'answer'}))));
  assert.throws(()=>validateStudyShape({},cases.map(c=>({...c,id:'duplicate'}))));
});
test('explicit small studies retain exact cohort and build counts', () => {
  const cases=Array.from({length:6},(_,i)=>({id:String(i),comparison:'answer'}));
  assert.doesNotThrow(()=>validateStudyShape({expectedCases:6,expectedBuilds:0},cases));
  assert.throws(()=>validateStudyShape({expectedCases:6},cases));
  for(const value of [null,0,-1,1.5,'6',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>validateStudyShape({expectedCases:value,expectedBuilds:0},cases));
  }
  for(const value of [null,-1,1.5,'0',NaN,Infinity,7]) {
    assert.throws(()=>validateStudyShape({expectedCases:6,expectedBuilds:value},cases));
  }
});
