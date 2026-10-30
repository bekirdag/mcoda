// Reports all attempts and costs. Artifact/tool capability is labeled separately
// from the answer comparison with the text-only raw model.
const percentile = (values,p) => { const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]:null; };
const ratio = (a,b) => Number.isFinite(a)&&Number.isFinite(b)&&b>0?a/b:null;
const mean = values=>values.reduce((a,b)=>a+b,0)/values.length;
export function summarizeWorkflowRows(rows) {
  const measured=rows.filter(row=>Number.isSafeInteger(row.usage?.tokens)&&row.usage.tokens>=0&&row.usage.estimated!==true&&!row.usage.pendingReservations?.length);
  const timed=rows.filter(row=>Number.isFinite(row.answerElapsedMs)&&row.answerElapsedMs>=0);
  return {attempts:rows.length,passed:rows.filter(row=>row.grade.passed).length,passRate:rows.length?rows.filter(row=>row.grade.passed).length/rows.length:null,
    reviewed:rows.filter(row=>row.grade.reviewer).length,criticalFailures:rows.filter(row=>row.grade.criticalPassed===false).length,
    pendingCriticalReviews:rows.filter(row=>row.grade.criticalPassed===null).length,executionFailures:rows.filter(row=>row.error).length,
    knownTokenSubtotal:measured.reduce((sum,row)=>sum+row.usage.tokens,0),unknownUsageAttempts:rows.length-measured.length,
    totalTokens:measured.length===rows.length?measured.reduce((sum,row)=>sum+row.usage.tokens,0):null,
    toolCalls:rows.reduce((sum,row)=>sum+(row.usage?.toolCalls??0),0),medianMs:timed.length===rows.length?percentile(timed.map(row=>row.answerElapsedMs),.5):null,
    p95Ms:timed.length===rows.length?percentile(timed.map(row=>row.answerElapsedMs),.95):null,unknownTimingAttempts:rows.length-timed.length};
}

function familyInterval(pairs) {
  if(!pairs.length)return null;
  const families=new Map();for(const pair of pairs){const group=families.get(pair.family)??[];group.push(Number(pair.candidate.grade.passed)-Number(pair.baseline.grade.passed));families.set(pair.family,group);}
  const groups=[...families.values()];let state=0x71e5d3a9;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
  const samples=[];for(let i=0;i<4000;i++){const draw=[];for(let j=0;j<groups.length;j++)draw.push(...groups[Math.floor(random()*groups.length)]);samples.push(mean(draw)*100);}
  return {lowPp:percentile(samples,.025),highPp:percentile(samples,.975),familyCount:groups.length,resamples:4000,method:'paired family bootstrap; development/reviewer limitations still apply'};
}

export function workflowReport(rows, manifest) {
  const arms=manifest.run.arms,taskIds=manifest.run.taskIds;
  if(new Set(rows.map(row=>`${row.caseId}:${row.arm}`)).size!==rows.length||rows.some(row=>!arms.includes(row.arm)||!taskIds.includes(row.caseId)))throw Error('Scored workflow outcome identities mismatch');
  const aggregate=Object.fromEntries(arms.map(arm=>[arm,summarizeWorkflowRows(rows.filter(row=>row.arm===arm))]));
  const groupBy=field=>Object.fromEntries([...new Set(rows.map(row=>row[field]))].sort().map(value=>[value,Object.fromEntries(arms.map(arm=>[arm,summarizeWorkflowRows(rows.filter(row=>row[field]===value&&row.arm===arm))]))]));
  const comparisons=[];
  for(const baseline of ['raw_direct','raw_tools'])for(const scope of baseline==='raw_direct'?['answer']:['answer','all_workflows']){
    const relevant=rows.filter(row=>scope==='all_workflows'||row.comparison==='answer');
    const byCase=new Map();for(const row of relevant){const group=byCase.get(row.caseId)??{};group[row.arm]=row;byCase.set(row.caseId,group);}
    const pairs=[...byCase.values()].filter(group=>group.codali_candidate&&group[baseline]).map(group=>({family:group.codali_candidate.family,candidate:group.codali_candidate,baseline:group[baseline]}));
    const candidate=summarizeWorkflowRows(pairs.map(pair=>pair.candidate)),raw=summarizeWorkflowRows(pairs.map(pair=>pair.baseline));
    const gains=pairs.length?(candidate.passRate-raw.passRate)*100:null;
    comparisons.push({baseline,scope,meaning:scope==='all_workflows'?'Completed-work capability with identical tool access, not model IQ':'Answer correctness under the stated review criteria',pairedCases:pairs.length,
      unpairedCases:byCase.size-pairs.length,candidate,raw,accuracyGainPp:gains,accuracyGainRelative:ratio(candidate.passRate,raw.passRate),
      familyInterval95:familyInterval(pairs),tokenRatio:ratio(candidate.totalTokens,raw.totalTokens),medianTimeRatio:ratio(candidate.medianMs,raw.medianMs),p95TimeRatio:ratio(candidate.p95Ms,raw.p95Ms)});
  }
  const failures=[];
  if(!manifest.runComplete||rows.length!==taskIds.length*arms.length)failures.push('Study is incomplete');
  if(taskIds.length<100||rows.some(row=>row.split==='development')||!manifest.run.freezeHash)failures.push('Requires a prospectively frozen non-development study of at least 100 cases');
  if(rows.some(row=>!row.grade.reviewer))failures.push('Review is incomplete');
  if(Object.values(aggregate).some(value=>value.unknownUsageAttempts||value.unknownTimingAttempts))failures.push('Complete usage and timing are required for every retained attempt');
  const candidate=aggregate.codali_candidate;
  if(!candidate||candidate.criticalFailures||candidate.pendingCriticalReviews)failures.push('Candidate critical review is incomplete or contains failures');
  const direct=comparisons.find(value=>value.baseline==='raw_direct'&&value.scope==='answer');
  if(!direct?.pairedCases||direct.unpairedCases||direct.accuracyGainPp<10)failures.push('Answer gain over raw-direct is below the provisional +10 percentage-point target');
  if(direct?.familyInterval95?.lowPp<=0)failures.push('Paired answer gain is not separated from zero at the reported confidence level');
  for(const [name,value]of [['tokens',direct?.tokenRatio],['median time',direct?.medianTimeRatio],['p95 time',direct?.p95TimeRatio]])if(value==null||value>1.5)failures.push(`Answer ${name} is unknown or exceeds 1.5x raw-direct`);
  const toolComparison=comparisons.find(value=>value.baseline==='raw_tools'&&value.scope==='all_workflows');
  if(!toolComparison?.pairedCases||toolComparison.unpairedCases||toolComparison.accuracyGainPp<=0
    ||!(toolComparison.familyInterval95?.lowPp>0))failures.push('Full-workflow gain over matched raw-tools is unmeasured or not separated from zero');
  const toolAnswers=comparisons.find(value=>value.baseline==='raw_tools'&&value.scope==='answer');
  if(!toolAnswers?.pairedCases||toolAnswers.unpairedCases||toolAnswers.accuracyGainPp<0)failures.push('Answer correctness regresses against matched raw-tools or is unmeasured');
  for(const comparison of [toolAnswers,toolComparison])for(const [name,value]of [['tokens',comparison?.tokenRatio],['median time',comparison?.medianTimeRatio],['p95 time',comparison?.p95TimeRatio]]){
    if(value==null||value>1.5)failures.push(`${comparison?.scope??'Unmeasured'} ${name} is unknown or exceeds 1.5x matched raw-tools`);
  }
  return {schemaVersion:1,protocol:'trust-workflow-scores-v1',aggregate,byDomain:groupBy('domain'),byComparison:groupBy('comparison'),comparisons,
    evaluationGate:{passed:!failures.length,failures,thresholdInterpretation:'Provisional +10 percentage points over raw-direct answers; positive full-workflow gain over matched raw-tools with no answer regression; at most 1.5x tokens, median and p95 time against each applicable baseline; no automatic promotion'},
    limitations:[...(manifest.limitations??[]),'These are task success scores, not a psychometric intelligence measurement.',
      'Unknown usage is retained and blocks efficiency qualification; known-token subtotals are not complete costs.',
      'Same-agent review, live-source variation and shared-host activity must be disclosed with conclusions.',
      'Media render usage is separate from language-model tokens; inspect retained job receipts for hardware/runtime costs.']};
}
