import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionController, type SessionEvent } from "../runtime/SessionController.js";
import { loadOrchestrationConfig } from "../config/OrchestrationConfig.js";
import { captureWorkspace, changedWorkspacePaths } from "../runtime/WorkspaceSnapshot.js";
import { runProcess } from "../tools/shell/AsyncProcess.js";
import { gradeTerminalTask, materializeTerminalTask, terminalClientBuildHash } from "./TerminalCorpusRunner.js";
import { terminalWorkflowCorpus, terminalWorkflowCorpusHash } from "./TerminalWorkflowCorpus.js";
import type { WorkState } from "../session/WorkTypes.js";
import { runEvaluationProcess } from "./EvaluationProcess.js";

export const LONG_WORKFLOW_VERSION = "long-workflows-v2";
export const longWorkflowScenarios = [
  { id: "data-delivery", objective: "Deliver a reliable data-processing toolkit with exact money totals, validated imports, CSV export and additive record migration.", modules: ["invoice-cents", "jsonl-import", "csv-export", "additive-record-migration"] },
  { id: "service-adapters", objective: "Deliver a service-adapter toolkit with safe headers, bounded async execution, locale fallback and interval reservations.", modules: ["header-normalization", "async-worker-pool", "locale-fallback", "interval-reservation"] },
  { id: "billing-audit", objective: "Deliver a billing-readiness package: source-backed duplicate-submit and tenant-isolation reports, exact invoice totals and a data-preserving migration.", modules: ["investigate-duplicate-submit", "investigate-tenant-key", "invoice-cents", "additive-record-migration"] },
  { id: "localized-export", objective: "Deliver localized export adapters with CSV correctness, normalized headers and a source-backed fictional render-service upgrade report.", modules: ["locale-fallback", "csv-export", "header-normalization", "research-pinned-upgrade"] },
] as const;
export type LongWorkflowScenario = typeof longWorkflowScenarios[number];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const longWorkflowHash = () => hash(JSON.stringify({ version: LONG_WORKFLOW_VERSION, scenarios: longWorkflowScenarios, prompts: longWorkflowScenarios.map(longWorkflowPrompt), steering, workflowHash: terminalWorkflowCorpusHash() }));
const steering = "Keep every original module contract and protected file. Add DELIVERY.md containing a concise test-and-delivery inventory with the exact path modules/<module-id>/test/task.test.mjs for each of the four modules. Do not claim unavailable checks ran, add features, or remove criteria. This is additional required work, not a replacement objective.";
const prefixPrompt = (module: string, prompt: string) => prompt.replace(/\b(src|test|docs|vendor-docs)\//g, `modules/${module}/$1/`);

export function longWorkflowPrompt(scenario: LongWorkflowScenario): string {
  const corpus = terminalWorkflowCorpus();
  return `${scenario.objective}\nThe repository has four independent module packages under modules/. Each module's package.json, user notes, and any paths not explicitly writable below must remain byte-identical. Root package.json and USER_NOTES.txt must also remain unchanged. No dependencies or unrelated features. Paths used to locate files in these instructions are workspace-relative. Inside a module JSON report, all source-path values (including owner, client, server, callers, evidence and citations) must be relative to that module directory, without its modules/<module-id>/ prefix. API endpoint values remain unchanged.\nRecord canonical requirements R2-R5, one per module contract below, plus the existing original R1 for final integration after all module tasks. Record phases and a dependency-valid plan; R1 is final integration and must depend on all module deliverables. Record a modular architecture decision with rationale and alternatives. Module tasks may be independent; no inter-module imports are needed.\n${scenario.modules.map((id, index) => `R${index + 2}: ${prefixPrompt(id, corpus.find(task => task.id === id)!.prompt)}`).join("\n\n")}\nInitially you are in planning-only mode: inspect and record the plan, but do not execute or complete it. Execution will resume in a new process with workspace permissions. The overall delivery includes actual tests and all four module outcomes. Preserve that objective across restarts and corrections.`;
}

interface JourneyDescriptor { schemaVersion: 1; scenarioId: string; configPath: string; configHash: string; clientBuildHash: string; root: string; objective: string; corpusHash: string }
interface Handoff { sessionId: string; stage: number; stateHash: string }
const saveNew = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });

/** One invocation is one OS process in the parent runner. Stage 2 deliberately
 * checkpoints after a verified task, never during a pending side effect. */
export async function runLongWorkflowStage(descriptorPath: string, stage: number): Promise<void> {
  if (![1, 2, 3, 4].includes(stage)) throw new Error("Unknown journey stage");
  const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as JourneyDescriptor;
  const scenario = longWorkflowScenarios.find(item => item.id === descriptor.scenarioId);
  if (descriptor.schemaVersion !== 1 || !scenario || descriptor.corpusHash !== longWorkflowHash()) throw new Error("Incompatible journey descriptor");
  const resolved = await loadOrchestrationConfig(descriptor.configPath);
  if (resolved.hash !== descriptor.configHash || await terminalClientBuildHash() !== descriptor.clientBuildHash) throw new Error("Journey configuration/client changed across processes");
  const root = path.resolve(descriptor.root); const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "state"); const events: SessionEvent[] = [];
  let checkpointTriggered = false; let controller!: SessionController;
  controller = new SessionController({ workspaceRoot, storageRoot, resolved, permissions: stage === 1 ? "plan" : "workspace", effort: "max",
    onEvent: event => {
      if (["model_route", "tool_receipt", "turn_failed", "turn_result", "usage"].includes(event.type)) events.push(event);
      if (stage === 2 && !checkpointTriggered && event.type === "tool_receipt"
        && controller.state?.tasks.some(task => task.status === "verified")) {
        const receipt = event.data.receipt as { status?: string; tool?: string };
        if (receipt.tool === "work_verify" && receipt.status === "success") { checkpointTriggered = true; controller.cancel(); }
      }
    } });
  const startedAt = new Date().toISOString(); let failure: string | undefined; let resumePreserved = stage === 1;
  const abort = () => controller.cancel(); process.once("SIGTERM", abort); process.once("SIGINT", abort);
  try {
    if (stage === 1) await controller.start(descriptor.objective);
    else {
      const previous = JSON.parse(await fs.readFile(path.join(root, `stage-${stage - 1}.handoff.json`), "utf8")) as Handoff;
      await controller.resume(previous.sessionId);
      resumePreserved = hash(JSON.stringify(controller.state)) === previous.stateHash;
      if (!resumePreserved) throw new Error("Canonical state changed across the process boundary");
    }
    if (stage === 3) {
      // Simulates a user edit made while the CLI was stopped. Existing bytes
      // remain protected; the new line must survive subsequent model work.
      await fs.appendFile(path.join(workspaceRoot, "USER_NOTES.txt"), "Concurrent user correction: preserve these notes and every original module contract.\n");
      await controller.steer(steering);
    }
    if (stage < 4) {
      try { await controller.run(); }
      catch (error) { if (!checkpointTriggered || !/Cancelled by user/.test(String(error))) throw error; }
    }
    for (let i = 0; i < (stage === 1 ? 2 : 1); i++) await controller.compact();
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally { process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); }
  const state = controller.state;
  const record = { schemaVersion: 1, stage, startedAt, endedAt: new Date().toISOString(), pid: process.pid,
    sessionId: controller.sessionId, failure, resumePreserved, checkpointTriggered, usage: controller.usageSnapshot(), state,
    routes: events.filter(event => event.type === "model_route").map(event => event.data),
    receipts: events.filter(event => event.type === "tool_receipt").map(event => event.data.receipt) };
  await saveNew(path.join(root, `stage-${stage}.result.json`), record);
  if (state && controller.sessionId) await saveNew(path.join(root, `stage-${stage}.handoff.json`), { sessionId: controller.sessionId, stage, stateHash: hash(JSON.stringify(state)) });
  if (failure) throw new Error(failure);
  if (stage === 2 && !checkpointTriggered) throw new Error("Execution did not reach the required verified-task checkpoint");
}

export function gradeLongWorkflowState(objective: string, state: WorkState, initial?: WorkState): string[] {
  const failures: string[] = [];
  if (state.originalObjective !== objective) failures.push("Original objective changed");
  for (const id of ["R1", "R2", "R3", "R4", "R5", "steering-2"]) {
    if (!state.requirements.some(r => r.id === id && r.required)) failures.push(`Required criterion lost: ${id}`);
    if (!state.tasks.some(task => task.status === "verified" && task.requirementIds.includes(id))) failures.push(`No verified owner: ${id}`);
  }
  if (state.status !== "completed") failures.push("Goal is not completed");
  if (!state.decisions.length) failures.push("Architecture decision missing");
  if (!state.phases?.length) failures.push("Phased plan missing");
  if (initial) {
    for (const criterion of initial.requirements) if (!state.requirements.some(r => r.id === criterion.id && r.description === criterion.description && r.required === criterion.required)) failures.push(`Criterion contract changed: ${criterion.id}`);
    for (const decision of initial.decisions) if (!state.decisions.some(d => JSON.stringify(d) === JSON.stringify(decision))) failures.push(`Architecture history changed: ${decision.id}`);
  }
  const finalOwners = state.tasks.filter(task => task.requirementIds.includes("R1"));
  const reaches = (id: string, target: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false; seen.add(id);
    const task = state.tasks.find(item => item.id === id); if (!task) return false;
    const phase = state.phases?.find(item => item.id === task.phaseId);
    const deps = [...task.dependsOn, ...state.tasks.filter(item => item.phaseId && phase?.dependsOn.includes(item.phaseId)).map(item => item.id)];
    return deps.some(dep => dep === target || reaches(dep, target, seen));
  };
  if (finalOwners.length !== 1 || state.tasks.filter(task => task.requirementIds.some(id => ["R2", "R3", "R4", "R5"].includes(id)))
    .some(task => !reaches(finalOwners[0]?.id ?? "", task.id))) failures.push("Original delivery integration does not depend on every module owner");
  if (state.amendments.length !== 1 || state.goalRevision !== 2) failures.push("Steering history was lost or unexpectedly replaced");
  if (state.checkpoints.filter(c => c.note.startsWith("Context compacted")).length < 5) failures.push("Fewer than five recorded compactions");
  return failures;
}

export async function runLongWorkflowJourney(options: { configPath: string; outputRoot: string; scenarioId: string; signal?: AbortSignal; onProgress?: (event: Record<string, unknown>) => void }): Promise<void> {
  const scenario = longWorkflowScenarios.find(item => item.id === options.scenarioId);
  if (!scenario) throw new Error("Unknown long workflow scenario");
  const root = path.resolve(options.outputRoot); const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(root, { mode: 0o700 }); await fs.mkdir(workspaceRoot, { mode: 0o700 }); await fs.mkdir(path.join(workspaceRoot, "modules"));
  const tasks = scenario.modules.map(id => terminalWorkflowCorpus().find(task => task.id === id)!);
  for (const task of tasks) await materializeTerminalTask(task, path.join(workspaceRoot, "modules", task.id));
  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { test: "node --test" } }) + "\n");
  const notes = "User-owned journey notes. Keep every original module and delivery requirement.\n";
  await fs.writeFile(path.join(workspaceRoot, "USER_NOTES.txt"), notes);
  await runProcess("git", ["-c", "core.hooksPath=/dev/null", "init", "--quiet"], { workspaceRoot, shellTimeoutMs: 10000 });
  await runProcess("git", ["-c", "core.hooksPath=/dev/null", "add", "--all"], { workspaceRoot, shellTimeoutMs: 10000 });
  await runProcess("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Codali evaluation", "-c", "user.email=codali-evaluation@localhost", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Long workflow fixture baseline"], { workspaceRoot, shellTimeoutMs: 10000 });
  const before = await captureWorkspace(workspaceRoot);
  const resolved = await loadOrchestrationConfig(options.configPath); const clientBuildHash = await terminalClientBuildHash();
  const descriptor: JourneyDescriptor = { schemaVersion: 1, scenarioId: scenario.id, configPath: path.resolve(options.configPath), configHash: resolved.hash, clientBuildHash, root, objective: longWorkflowPrompt(scenario), corpusHash: longWorkflowHash() };
  const descriptorPath = path.join(root, "descriptor.json"); await saveNew(descriptorPath, descriptor);
  const startedAt = new Date().toISOString();
  await saveNew(path.join(root, "manifest.json"), { ...descriptor, startedAt, version: LONG_WORKFLOW_VERSION,
    limitations: ["Four composed module journeys reuse the workflow corpus; these are retention/recovery probes, not fresh coding hold-outs",
      "A scripted pause after verified work is a clean checkpoint, not a SIGKILL or an uncertain external side effect",
      "Multi-hour qualification is reported separately from correctness; idle time is never added to meet duration",
      "No mixed-media, physical GPU admission, production coexistence or statistical comparison claim"] });
  const failures: string[] = []; const stages: Array<{ stage: number; pid?: number; failure?: string; resumePreserved?: boolean; state?: WorkState }> = [];
  for (const stage of [1, 2, 3, 4]) {
    options.signal?.throwIfAborted(); options.onProgress?.({ type: "journey_stage_start", scenarioId: scenario.id, stage, at: new Date().toISOString() });
    try {
      await runEvaluationProcess({ file: fileURLToPath(import.meta.url), args: ["--stage", descriptorPath, String(stage)], cwd: root,
        config: resolved.config, timeoutMs: 4 * 3600_000, signal: options.signal });
    } catch (error) { failures.push(`Stage ${stage}: ${String(error).slice(0, 1000)}`); }
    try { stages.push(JSON.parse(await fs.readFile(path.join(root, `stage-${stage}.result.json`), "utf8"))); }
    catch { failures.push(`Stage ${stage} did not produce a durable result`); }
    options.onProgress?.({ type: "journey_stage_end", scenarioId: scenario.id, stage, failures: [...failures], at: new Date().toISOString() });
    if (failures.length) break;
  }
  const grades = [];
  for (const task of tasks) grades.push({ taskId: task.id, grade: await gradeTerminalTask(task, path.join(workspaceRoot, "modules", task.id)) });
  for (const result of grades) if (!result.grade.passed) failures.push(`Module ${result.taskId}: ${result.grade.failures.join('; ')}`);
  const final = stages.at(-1)?.state;
  if (final) failures.push(...gradeLongWorkflowState(descriptor.objective, final, stages[0]?.state)); else failures.push("Final work state missing");
  const after = await captureWorkspace(workspaceRoot); const changed = changedWorkspacePaths(before, after);
  const allowed = new Set(["USER_NOTES.txt", "DELIVERY.md", ...tasks.flatMap(task => task.allowedChanges.map(file => `modules/${task.id}/${file}`))]);
  if (changed.some(file => !allowed.has(file))) failures.push("Changes escaped the journey scope");
  const expectedNotes = notes + "Concurrent user correction: preserve these notes and every original module contract.\n";
  if (await fs.readFile(path.join(workspaceRoot, "USER_NOTES.txt"), "utf8").catch(() => "") !== expectedNotes) failures.push("Concurrent user notes were lost or changed");
  const delivery = await fs.readFile(path.join(workspaceRoot, "DELIVERY.md"), "utf8").catch(() => "");
  if (!scenario.modules.every(id => delivery.includes(`modules/${id}/test/task.test.mjs`))) failures.push("Additional delivery inventory is incomplete");
  if (new Set(stages.map(item => item.pid)).size !== 4 || stages.length !== 4 || stages.some(item => !item.resumePreserved)) failures.push("Four distinct processes did not retain canonical state");
  const endedAt = new Date().toISOString(); const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
  const result = { schemaVersion: 1, scenarioId: scenario.id, startedAt, endedAt, elapsedMs, passed: failures.length === 0,
    multiHourDurationReached: elapsedMs >= 2 * 3600_000, failures, grades, changedPaths: changed, stages, configHash: resolved.hash, clientBuildHash };
  await saveNew(path.join(root, "result.json"), result);
  options.onProgress?.({ type: "journey_result", scenarioId: scenario.id, passed: result.passed, multiHourDurationReached: result.multiHourDurationReached, failures, endedAt });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--stage") {
  runLongWorkflowStage(process.argv[3], Number(process.argv[4])).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}
