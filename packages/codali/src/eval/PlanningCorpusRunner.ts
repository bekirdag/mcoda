import { promises as fs } from "node:fs";
import path from "node:path";
import { SessionController, type SessionEvent } from "../runtime/SessionController.js";
import { captureWorkspace, changedWorkspacePaths } from "../runtime/WorkspaceSnapshot.js";
import { loadOrchestrationConfig, type EffortLevel } from "../config/OrchestrationConfig.js";
import { terminalClientBuildHash } from "./TerminalCorpusRunner.js";
import { gradePlanningState, planningCorpus, planningCorpusHash, planningPrompt, PLANNING_CORPUS_VERSION } from "./PlanningCorpus.js";

export interface PlanningRunOptions {
  configPath: string;
  outputRoot: string;
  caseIds?: string[];
  effort?: EffortLevel;
  signal?: AbortSignal;
  onProgress?: (event: Record<string, unknown>) => void;
}

/** Uses the real controller, permission gate and configured route. No evaluator
 * model can turn a failing deterministic grade into a passing one. */
export async function runPlanningCorpus(options: PlanningRunOptions): Promise<void> {
  const resolved = await loadOrchestrationConfig(options.configPath);
  const clientBuildHash = await terminalClientBuildHash();
  const corpus = planningCorpus();
  if (options.caseIds?.some(id => !corpus.some(item => item.id === id))) throw new Error("Unknown planning case");
  const selected = options.caseIds ? corpus.filter(item => options.caseIds!.includes(item.id)) : corpus;
  const root = path.resolve(options.outputRoot);
  await fs.mkdir(root, { mode: 0o700 });
  const save = (file: string, value: unknown) => fs.writeFile(path.join(root, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await save("manifest.json", { schemaVersion: 1, corpusVersion: PLANNING_CORPUS_VERSION, corpusHash: planningCorpusHash(), clientBuildHash,
    configHash: resolved.hash, effort: options.effort ?? "high", caseIds: selected.map(item => item.id), startedAt: new Date().toISOString(),
    limitations: ["Six closed-world planning probes with explicit criterion IDs and constrained architecture options; not general architecture certification",
      "Checks actual durable controller records, not quality of final prose", "Rationale grading checks presence, not semantic correctness",
      "Docdex is disabled for these code-free probes; retrieval/media/implementation quality require separate qualification",
      "Compaction/resume is checked in a new controller instance, not a new OS process", "No helper/review benefit or production performance claim"] });
  for (const item of selected) {
    options.signal?.throwIfAborted();
    if ((await loadOrchestrationConfig(options.configPath)).hash !== resolved.hash || await terminalClientBuildHash() !== clientBuildHash) throw new Error("Evaluation config/build changed; start a separately identified run");
    const directory = path.join(root, item.id); const workspaceRoot = path.join(directory, "workspace"); const storageRoot = path.join(directory, "state");
    await fs.mkdir(directory, { mode: 0o700 }); await fs.mkdir(workspaceRoot, { mode: 0o700 });
    await fs.writeFile(path.join(workspaceRoot, "USER_NOTES.md"), "Uncommitted user notes. Planning must preserve this file.\n", { mode: 0o600, flag: "wx" });
    const before = await captureWorkspace(workspaceRoot);
    const events: SessionEvent[] = [];
    const controller = new SessionController({ workspaceRoot, storageRoot, resolved, docdex: false, permissions: "plan", effort: options.effort ?? "high",
      onEvent: event => { if (["model_route", "tool_receipt", "turn_result", "turn_failed"].includes(event.type)) events.push(event); } });
    const startedAt = new Date().toISOString();
    options.onProgress?.({ type: "planning_start", caseId: item.id, startedAt });
    let failure: string | undefined;
    const abort = () => controller.cancel();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await controller.start(planningPrompt(item));
      options.signal?.throwIfAborted();
      await controller.run();
      await controller.compact();
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally { options.signal?.removeEventListener("abort", abort); }
    if (!controller.state || !controller.sessionId) throw new Error(failure ?? "Planner failed before creating state");
    const grade = gradePlanningState(item, controller.state);
    const after = await captureWorkspace(workspaceRoot); const changedPaths = changedWorkspacePaths(before, after);
    if (changedPaths.length) grade.failures.push("Planning changed workspace files");
    const sideEffects = events.filter(event => event.type === "tool_receipt").map(event => event.data.receipt as { tool: string; status: string })
      .filter(receipt => ["write_file", "run_shell", "work_verify", "work_complete"].includes(receipt.tool));
    if (sideEffects.length) grade.failures.push("Planner attempted implementation or completion during planning-only work");
    const resumed = new SessionController({ workspaceRoot, storageRoot, resolved, docdex: false, permissions: "plan" });
    let resumePreserved = false;
    try { await resumed.resume(controller.sessionId); resumePreserved = JSON.stringify(resumed.state) === JSON.stringify(controller.state); }
    catch (error) { grade.failures.push(`Resume failed: ${String(error)}`); }
    if (!resumePreserved) grade.failures.push("Durable plan changed or was lost across compaction/resume");
    grade.passed = grade.failures.length === 0 && !failure;
    const record = { caseId: item.id, startedAt, endedAt: new Date().toISOString(), passed: grade.passed, failure, grade, changedPaths, resumePreserved,
      configHash: resolved.hash, clientBuildHash, sessionId: controller.sessionId, usage: controller.usageSnapshot(),
      routes: events.filter(event => event.type === "model_route").map(event => event.data), sideEffects, state: controller.state };
    await save(`${item.id}.result.json`, record);
    await fs.appendFile(path.join(root, "results.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
    options.onProgress?.({ type: "planning_result", caseId: item.id, passed: record.passed, failures: grade.failures, failure, endedAt: record.endedAt });
  }
  await save("completed.json", { endedAt: new Date().toISOString(), cases: selected.length });
}
