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
test('only app builds may exceed the 30-minute deadline', () => {
  const study={expectedCases:2,expectedBuilds:1};
  const make=(answer,build)=>[{id:'q',comparison:'answer',execution:{deadlineMs:answer}},{id:'app',comparison:'implementation',execution:{deadlineMs:build}}];
  assert.doesNotThrow(()=>validateStudyShape(study,make(1800000,86400000)));
  assert.throws(()=>validateStudyShape(study,make(1800001,86400000)),/30-minute/);
  assert.throws(()=>validateStudyShape(study,[{id:'q',comparison:'artifact',execution:{deadlineMs:86400000}},make(1,1)[1]]),/30-minute/);
});
test('research answers may run 45 minutes, no longer', () => {
  const study={expectedCases:2,expectedBuilds:1};
  const make=ms=>[{id:'r',domain:'research',comparison:'answer',execution:{deadlineMs:ms}},{id:'app',comparison:'implementation',execution:{deadlineMs:86400000}}];
  assert.doesNotThrow(()=>validateStudyShape(study,make(2700000)));
  assert.throws(()=>validateStudyShape(study,make(2700001)),/45-minute/);
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
