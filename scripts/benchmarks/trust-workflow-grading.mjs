// Private host-side expectations. Never import into a model attempt.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createIsolatedExecutor } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import { gradeArtifact, validateArtifactSpec } from './trust-artifacts.mjs';
import { hash } from './trust-common.mjs';
import { workflowPath, validateWorkflowCase } from './trust-workflow-protocol.mjs';
import { snapshotWorkflowWorkspace } from './trust-workflow-workspace.mjs';
import { validateWorkflowEvidenceRequirements, workflowReviewBundle } from './trust-workflow-evidence.mjs';

const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === fields.split(',').sort().join();
const expectedOutput = value => exact(value, 'format,equals') && ['text','json'].includes(value.format)
  && (value.format !== 'text' || typeof value.equals === 'string') && JSON.stringify(value.equals)?.length <= 24000;
const list = (value, max) => Array.isArray(value) && value.length <= max;

export function validateWorkflowGrading(task, spec) {
  validateWorkflowCase(task);
  if (!exact(spec, 'caseId,criteria,requirements,turns,artifacts,commands,preservePaths') || spec.caseId !== task.id) throw Error('Private workflow grading identity/fields mismatch');
  const turnCount = 1 + (task.followUps?.length ?? 0);
  validateWorkflowEvidenceRequirements(spec.requirements);
  if (spec.requirements.some(item => item.turnIndex >= turnCount)) throw Error('Evidence targets an absent turn');
  if (!list(spec.criteria, 40) || !spec.criteria.length || spec.criteria.some(item => !exact(item,'id,criterion')
    || !/^[a-z][a-z0-9_.-]{0,99}$/.test(item.id) || ['intent','faithfulness','critical'].includes(item.id)
    || typeof item.criterion !== 'string' || !item.criterion.trim() || item.criterion.length > 4000)
    || new Set(spec.criteria.map(item=>item.id)).size !== spec.criteria.length) throw Error('Invalid private review criteria');
  if (!list(spec.turns, 8) || spec.turns.some(item => !exact(item,'turnIndex,output') || !Number.isSafeInteger(item.turnIndex)
    || item.turnIndex < 0 || item.turnIndex >= turnCount || !expectedOutput(item.output))
    || new Set(spec.turns.map(item=>item.turnIndex)).size !== spec.turns.length) throw Error('Invalid independent turn checks');
  if (!list(spec.artifacts, 12)) throw Error('Invalid artifact checks');
  spec.artifacts.forEach(validateArtifactSpec);
  if (new Set(spec.artifacts.map(item=>item.path)).size !== spec.artifacts.length) throw Error('Duplicate artifact path');
  if (!list(spec.commands, 16) || spec.commands.some(item => !exact(item,'id,command,args,output,timeoutMs')
    || !/^[a-z][a-z0-9_.-]{0,60}$/.test(item.id) || !['node','python3'].includes(item.command)
    || !list(item.args,32) || !item.args.length || item.args.some(value=>typeof value !== 'string'||value.length>4000||value.includes('\0'))
    || !expectedOutput(item.output) || !Number.isSafeInteger(item.timeoutMs) || item.timeoutMs < 100 || item.timeoutMs > 10000)
    || new Set(spec.commands.map(item=>item.id)).size !== spec.commands.length) throw Error('Invalid independent program checks');
  for (const check of spec.commands) {
    workflowPath(check.args[0]);
    if (check.args[0].startsWith('-') || !(check.command === 'node' ? /\.(?:mjs|cjs|js)$/ : /\.py$/).test(check.args[0])) throw Error('Program check requires a workspace script, not interpreter flags');
  }
  if (!list(spec.preservePaths,100) || new Set(spec.preservePaths).size !== spec.preservePaths.length) throw Error('Invalid preservation checks');
  for (const file of spec.preservePaths) { workflowPath(file); if (!Object.hasOwn(task.files,file)) throw Error('Preserved file must be an original fixture'); }
  if (task.comparison === 'artifact' && !spec.artifacts.length || task.comparison === 'implementation' && !spec.commands.length) throw Error('Completed-work comparison requires independent artifact/program checks');
  return spec;
}

function compareOutput(actual, expected) {
  try { return isDeepStrictEqual(expected.format === 'json' ? JSON.parse(actual) : actual.trim(), expected.equals); }
  catch { return false; }
}

/** Copy and verify retained bytes before executing submitted programs. Private
 * expected values stay in this process, outside the sandboxed program's inputs. */
export async function observeWorkflow({ task, spec, result, events, mediaJobs = [], localMediaPolicy, signal }) {
  validateWorkflowGrading(task, spec);
  const independentChecks = [], artifacts = [], programs = [];
  const check = (id, passed, evidence) => independentChecks.push({ id, passed, evidence: evidence.slice(0,4000) });
  for (const assertion of spec.turns) {
    const content = result.turns?.[assertion.turnIndex]?.content;
    check(`turn:${assertion.turnIndex}`, typeof content === 'string' && compareOutput(content,assertion.output),
      `Expected ${assertion.output.format} ${JSON.stringify(assertion.output.equals)}; observed SHA256 ${typeof content==='string'?hash(content):'missing'}.`);
  }
  let scratch;
  try {
    if (!result.workspaceAfter || typeof result.originalWorkspace !== 'string') throw Error('Missing retained workspace observation');
    scratch = await fs.mkdtemp(path.join(os.tmpdir(),'codali-workflow-grade-')); await fs.chmod(scratch,0o700);
    const observed = await snapshotWorkflowWorkspace(result.originalWorkspace,{copyTo:scratch,expected:result.workspaceAfter,signal});
    check('retained_workspace',true,`Verified ${Object.keys(observed).length} retained file hashes against the post-attempt record.`);
    for (const file of spec.preservePaths) check(`preserve:${file}`,observed[file]===task.files[file].sha256,`Original fixture ${file} must retain SHA256 ${task.files[file].sha256}.`);
    for (const specification of spec.artifacts) {
      const artifact = await gradeArtifact(scratch,specification,{mediaJobs,localMediaPolicy,signal}); artifacts.push(artifact);
      check(`artifact:${specification.path}`,artifact.technicalPassed,JSON.stringify({sha256:artifact.sha256,failures:artifact.failures,semanticReviewRequired:true}));
    }
    for (const specification of spec.commands) {
      signal?.throwIfAborted();
      const observation = { id:specification.id,command:specification.command,args:specification.args,sourceSha256:observed[specification.args[0]],passed:false };
      try {
        if (!observation.sourceSha256) throw Error('Required program file is absent');
        const command = specification.command === 'node' ? process.execPath : 'python3';
        const flags = specification.command === 'node' ? ['--max-old-space-size=128'] : ['-E','-s','-B'];
        const receipt = await createIsolatedExecutor({network:false})(command,[...flags,...specification.args],
          {workspaceRoot:scratch,allowedWritePaths:[],signal,shellTimeoutMs:specification.timeoutMs,shellMaxOutputBytes:64000});
        const data = receipt.data;
        if (data.truncated) throw Error('Program observation was truncated');
        Object.assign(observation,{stdout:data.stdout,stderr:data.stderr,passed:compareOutput(data.stdout,specification.output)});
      } catch(error) { signal?.throwIfAborted(); observation.error=String(error.message??error).slice(0,2000); }
      programs.push(observation);
      check(`program:${specification.id}`,observation.passed,JSON.stringify({sourceSha256:observation.sourceSha256,stdout:observation.stdout?.slice(0,2500),error:observation.error,expected:specification.output}));
    }
  } catch(error) {
    signal?.throwIfAborted();
    check('workspace_observation_failed',false,String(error.message??error));
  } finally { if(scratch) await fs.rm(scratch,{recursive:true,force:true}); }
  const normalizedResult = {...result,turns:result.turns??[]};
  const bundle = workflowReviewBundle({task,result:normalizedResult,events,requirements:spec.requirements,criteria:spec.criteria,independentChecks,
    independentObservations:[...artifacts.map(value=>({kind:'artifact',...value})),...programs.map(value=>({kind:'program',...value}))]});
  return {bundle,artifacts,programs};
}
