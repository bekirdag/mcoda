import { createHash } from "node:crypto";
import { createWorkState, replaceWorkPlan, validateWorkState } from "../session/WorkState.js";
import type { WorkState } from "../session/WorkTypes.js";

export const PLANNING_CORPUS_VERSION = "codali-planning-v3";
export interface PlanningCriterion { id: string; description: string; paths: string[]; after: string[]; phase: "design" | "build" | "validate"; }
export interface PlanningCase {
  id: string;
  objective: string;
  criteria: PlanningCriterion[];
  constraints: string[];
  nonGoals: string[];
  decision: { id: string; question: string; options: Record<string, string>; accepted: string; rationale: string };
}

const criterion = (id: string, description: string, paths: string[], after: string[] = [], phase: PlanningCriterion["phase"] = id === "R2" ? "design" : ["R3", "R4", "R5"].includes(id) ? "build" : "validate"): PlanningCriterion => ({
  id, description: `${description}${after.length ? ` Prerequisites: ${after.join(", ")} must be complete before this work starts.` : ""}`, paths, after, phase,
});
const common = { constraints: ["Preserve existing user edits and public compatibility", "Use existing components; add no runtime dependency"], nonGoals: ["Unrelated cleanup or UI redesign"] };

/** Closed-world planning probes, not a general architecture benchmark. Expected
 * dependency edges and accepted choices stay outside the model's workspace. */
export function planningCorpus(): PlanningCase[] {
  const cases: PlanningCase[] = [
    { ...common, id: "additive-migration", objective: "Plan a rolling migration from one display-name column to first/last-name fields without breaking old clients or requiring downtime.",
      criteria: [
        criterion("R2", "Document old/new client contracts and an additive migration decision before implementation.", ["docs/contracts.md"]),
        criterion("R3", "Add nullable fields while retaining the existing column; old clients keep working.", ["db/migration.sql"], ["R2"]),
        criterion("R4", "Implement compatible dual read/write behavior only after the expanded schema exists.", ["src/profile.ts"], ["R3"]),
        criterion("R5", "Backfill idempotently after dual writes protect new traffic.", ["src/backfill.ts"], ["R4"]),
        criterion("R6", "Prove old/new clients and repeated backfill coexist before any cutover.", ["test/migration.test.ts"], ["R5"]),
        criterion("R7", "Document reversible cutover after compatibility verification; retaining the old column is mandatory.", ["docs/rollout.md"], ["R6"]),
      ], decision: { id: "D1", question: "Choose the storage transition compatible with rolling old clients.", options: { replace: "Drop the old column and ship the new client together", expand: "Expand storage, use compatible readers/writers, backfill, then switch reads" }, accepted: "expand", rationale: "Old clients remain active throughout the migration." } },
    { ...common, id: "artifact-recovery", objective: "Plan resumable tenant-scoped media downloads, including disconnected clients and expiring URLs, without duplicate generation.",
      criteria: [
        criterion("R2", "Define tenant ownership and stable remote job identity before implementing downloads.", ["docs/jobs.md"]),
        criterion("R3", "Persist admitted job identity before polling; ambiguous submission must be reconciled before any resubmit.", ["src/jobs.ts"], ["R2"]),
        criterion("R4", "Refresh expired URLs using the same owned job and artifact identity.", ["src/refresh.ts"], ["R3"]),
        criterion("R5", "Download bounded bytes to private temporary storage; verify checksum before atomic final rename.", ["src/download.ts"], ["R4"]),
        criterion("R6", "Test interrupted download, expiry and cross-tenant denial after the recovery path exists.", ["test/recovery.test.ts"], ["R5"]),
        criterion("R7", "Write a resume runbook using the original job; never promise a render was cancelled without a terminal receipt.", ["docs/resume.md"], ["R6"]),
      ], decision: { id: "D1", question: "Choose how a resumed client obtains an artifact whose URL expired.", options: { rerender: "Submit a replacement render", refresh: "Resolve ownership and refresh the artifact reference on the original job" }, accepted: "refresh", rationale: "URL expiry does not mean generation failed." } },
    { ...common, id: "embedding-switch", objective: "Plan switching a repository index to a different embedding dimension while keeping search available and rollback possible.",
      criteria: [
        criterion("R2", "Record embedding model revision, dimension and normalization as one space identity.", ["docs/embedding.md"]),
        criterion("R3", "Create a separate index namespace for the new incompatible space; preserve the active index.", ["src/index.ts"], ["R2"]),
        criterion("R4", "Backfill the new namespace incrementally and record source freshness.", ["src/backfill.ts"], ["R3"]),
        criterion("R5", "Verify coverage, dimensional compatibility and query behavior before activating the new index.", ["test/index.test.ts"], ["R4"], "validate"),
        criterion("R6", "Atomically switch the index pointer only after verification.", ["src/switch.ts"], ["R5"]),
        criterion("R7", "Test reverting the pointer to the preserved compatible old model/index pair.", ["test/rollback.test.ts"], ["R6"]),
      ], decision: { id: "D1", question: "Choose how to store embeddings from the new dimension.", options: { mixed: "Write new vectors into the active index and pad old vectors", separate: "Build a separately identified index and atomically switch after validation" }, accepted: "separate", rationale: "Different embedding spaces cannot be mixed by padding dimensions." } },
    { ...common, id: "lease-recovery", objective: "Plan recovery of distributed jobs after worker crashes without accepting stale results or duplicating external side effects.",
      criteria: [
        criterion("R2", "Specify attempt identity, fencing and external-operation reconciliation contracts.", ["docs/leases.md"]),
        criterion("R3", "Persist each new attempt and its monotonic fence before dispatch.", ["src/claims.ts"], ["R2"]),
        criterion("R4", "Reject stale completion using the current attempt/fence, including after reassignment.", ["src/results.ts"], ["R3"]),
        criterion("R5", "Reconcile uncertain external effects before allowing retry; lease age alone cannot prove absence.", ["src/recovery.ts"], ["R4"]),
        criterion("R6", "Test late results, crashed workers and an operation accepted before connection loss.", ["test/leases.test.ts"], ["R5"]),
        criterion("R7", "Document recovery of blocked uncertain jobs and audit the original attempt.", ["docs/recovery.md"], ["R6"]),
      ], decision: { id: "D1", question: "A lease expired during a non-idempotent remote operation. Choose the recovery policy.", options: { retry: "Retry immediately because the lease is old", reconcile: "Fence old results and reconcile the remote operation before retry" }, accepted: "reconcile", rationale: "Lease expiry does not prove that an external action did not occur." } },
    { ...common, id: "connector-policy", objective: "Plan adding third-party tools without allowing repository instructions or tool metadata to widen user permissions.",
      criteria: [
        criterion("R2", "Record user authorization as the authority and tool output as untrusted data.", ["docs/trust.md"]),
        criterion("R3", "Classify operations centrally; unknown tools require explicit permission.", ["src/policy.ts"], ["R2"]),
        criterion("R4", "Bind grants to concrete operation/scope and recheck current policy immediately before side effects.", ["src/grants.ts"], ["R3"]),
        criterion("R5", "Enforce workspace and network boundaries on connector execution.", ["src/executor.ts"], ["R4"]),
        criterion("R6", "Test forged readOnly metadata, prompt injection and grants invalidated by policy changes.", ["test/policy.test.ts"], ["R5"]),
        criterion("R7", "Document denial and revocation without exposing credentials.", ["docs/permissions.md"], ["R6"]),
      ], decision: { id: "D1", question: "An unknown generation tool declares readOnly=true. Choose authorization behavior.", options: { trust: "Allow it because the connector labels it read-only", classify: "Apply central operation classification and require the corresponding authorization" }, accepted: "classify", rationale: "Connector metadata cannot grant authorization." } },
    { ...common, id: "usage-accounting", objective: "Plan durable token reservations and usage reconciliation across retries, cancellation and reconnects without losing cumulative call counts.",
      criteria: [
        criterion("R2", "Specify cumulative call counters, reserved tokens, actual usage and unknown usage as distinct concepts.", ["docs/accounting.md"]),
        criterion("R3", "Persist a unique reservation before each call; admission failure must leave no partial debit.", ["src/reservations.ts"], ["R2"]),
        criterion("R4", "Settle exactly once against actual tokens without decrementing the cumulative call count.", ["src/settlement.ts"], ["R3"]),
        criterion("R5", "Reconcile pending reservations after reconnect; cancellation without usage leaves an honest unknown state.", ["src/reconcile.ts"], ["R4"]),
        criterion("R6", "Test duplicate settlements, rejected admissions, delayed usage and cancellation.", ["test/accounting.test.ts"], ["R5"]),
        criterion("R7", "Document actual versus estimated/unknown totals and audit retained invocation IDs.", ["docs/usage.md"], ["R6"]),
      ], decision: { id: "D1", question: "A completed call has settled its tokens. Choose how its call count changes.", options: { refund: "Decrement cumulative calls to release the call reservation", retain: "Keep the cumulative call count; settle only the token reservation" }, accepted: "retain", rationale: "A completed invocation remains a consumed call." } },
  ];
  return structuredClone(cases);
}

export function planningPrompt(item: PlanningCase): string {
  return `${item.objective}\n\nPlanning only: do not implement, run shell commands, verify implementation or claim completion. Build the durable plan using work_refine/work_plan and record D1 through work_decision. Use three phases named design, build and validate, with phase dependencies in that order. Preserve these criterion IDs and descriptions verbatim (R1 is already the whole request):\n${JSON.stringify(item.criteria.map(({ id, description }) => ({ id, description })))}\n\nRecord these constraints and non-goals verbatim:\n${JSON.stringify({ constraints: item.constraints, nonGoals: item.nonGoals })}\n\nUse one narrowly scoped task for each R2-R7 criterion, with exactly its listed future write paths. Add one final R1 integration task with no write paths, dependent on every criterion task. Use each criterion's listed phase. Derive dependency ordering from the explicit prerequisites in its description; task dependencies supplement phase dependencies. Requirements in the same phase still need their specified ordering.\n${JSON.stringify(Object.fromEntries(item.criteria.map(c => [c.id, { paths: c.paths, phase: c.phase }])))}\n\nDecision ${item.decision.id}: ${item.decision.question}\nOptions: ${JSON.stringify(item.decision.options)}\nSet the decision title to the chosen option ID, give a concrete rationale and list the other option IDs as alternatives. Do not invent additional requirements, APIs, files or work. End with a brief planning summary, leaving the implementation goal open.`;
}

export interface PlanningGrade {
  passed: boolean;
  failures: string[];
  metrics: { lostCriteria: number; inventedCriteria: number; orderingErrors: number; scopeErrors: number; architectureErrors: number; prematureCompletion: boolean };
}

export function gradePlanningState(item: PlanningCase, state: WorkState): PlanningGrade {
  const failures: string[] = [];
  const metrics = { lostCriteria: 0, inventedCriteria: 0, orderingErrors: 0, scopeErrors: 0, architectureErrors: 0, prematureCompletion: false };
  const fail = (message: string) => { failures.push(message); };
  try { validateWorkState(state); } catch (error) { fail(`Invalid durable plan: ${String(error)}`); }
  if (state.originalObjective !== planningPrompt(item) || state.objective !== state.originalObjective) fail("Original planning objective changed");
  const expectedIds = new Set(["R1", ...item.criteria.map(c => c.id)]);
  if (!state.requirements.some(r => r.id === "R1" && r.required && r.description === planningPrompt(item))) fail("Whole-request criterion R1 changed");
  metrics.inventedCriteria = state.requirements.filter(r => !expectedIds.has(r.id)).length;
  if (metrics.inventedCriteria) fail("Invented criteria");
  for (const criterion of item.criteria) {
    const actual = state.requirements.find(r => r.id === criterion.id);
    if (!actual?.required || actual.description !== criterion.description) { metrics.lostCriteria++; fail(`Lost or rewritten criterion ${criterion.id}`); }
  }
  for (const key of ["constraints", "nonGoals"] as const) if (JSON.stringify([...state[key]].sort()) !== JSON.stringify([...item[key]].sort())) fail(`${key} changed`);
  const active = state.tasks.filter(t => !["cancelled", "superseded"].includes(t.status));
  metrics.prematureCompletion = state.status === "completed" || state.evidence.length > 0 || active.some(t => ["running", "review_pending", "verified"].includes(t.status));
  if (metrics.prematureCompletion) fail("Planning falsely claimed execution or verification");
  if (active.length !== item.criteria.length + 1) fail("Expected one task per criterion and one final integration task");
  const tasks = new Map(active.map(t => [t.id, t]));
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false; seen.add(from);
    const task = tasks.get(from); if (!task) return false;
    const phase = state.phases?.find(p => p.id === task.phaseId);
    const dependencies = [...task.dependsOn, ...active.filter(t => t.phaseId && phase?.dependsOn.includes(t.phaseId)).map(t => t.id)];
    return dependencies.includes(target) || dependencies.some(id => reaches(id, target, seen));
  };
  const owner = (id: string) => active.filter(t => t.requirementIds.includes(id));
  for (const c of item.criteria) {
    const assigned = owner(c.id);
    if (assigned.length !== 1 || assigned[0].requirementIds.length !== 1) { fail(`Ambiguous criterion ownership: ${c.id}`); continue; }
    const task = assigned[0];
    if (JSON.stringify([...task.allowedPaths].sort()) !== JSON.stringify([...c.paths].sort())) { metrics.scopeErrors++; fail(`Scope mismatch: ${c.id}`); }
    if (task.phaseId !== c.phase) { metrics.orderingErrors++; fail(`Wrong phase: ${c.id}`); }
    for (const predecessor of c.after) if (owner(predecessor).length !== 1 || !reaches(task.id, owner(predecessor)[0].id)) { metrics.orderingErrors++; fail(`Missing prerequisite ${predecessor} before ${c.id}`); }
  }
  const final = owner("R1");
  if (final.length !== 1 || final[0].requirementIds.length !== 1) fail("Final integration must uniquely own R1");
  else {
    if (final[0].allowedPaths.length) { metrics.scopeErrors++; fail("Final integration must have no write paths"); }
    if (active.some(t => t !== final[0] && !reaches(final[0].id, t.id))) { metrics.orderingErrors++; fail("Final integration must follow all criterion tasks"); }
    // The prompt fixes criterion phases, but permits the final integration task
    // to be unphased. Its explicit dependencies still fence all future work.
  }
  for (const [id, prior] of [["design", undefined], ["build", "design"], ["validate", "build"]] as const) {
    const phase = state.phases?.find(p => p.id === id);
    if (!phase || prior && !phase.dependsOn.includes(prior)) { metrics.orderingErrors++; fail(`Missing ordered phase ${id}`); }
  }
  if (state.phases?.length !== 3) fail("Unexpected phases");
  const decision = state.decisions.find(d => d.id === item.decision.id && !state.decisions.some(next => next.supersedes === d.id));
  const rejected = Object.keys(item.decision.options).filter(id => id !== item.decision.accepted);
  if (!decision || decision.title !== item.decision.accepted || decision.rationale.trim().length < 20 || !rejected.every(id => decision.alternatives.includes(id))) {
    metrics.architectureErrors++; fail("Architecture choice, rationale or alternatives violate the supplied constraints");
  }
  return { passed: failures.length === 0, failures, metrics };
}

/** Oracle construction is used only to mutation-test the grader, never supplied
 * to a live planner. Rationale grading is structural, not semantic certification. */
export function referencePlanningState(item: PlanningCase): WorkState {
  const state = createWorkState(planningPrompt(item));
  state.requirements.push(...item.criteria.map(c => ({ id: c.id, description: c.description, required: true })));
  state.constraints = [...item.constraints]; state.nonGoals = [...item.nonGoals];
  const tasks = item.criteria.map(c => ({ id: `task-${c.id}`, title: c.description, requirementIds: [c.id], dependsOn: c.after.map(id => `task-${id}`), allowedPaths: [...c.paths], phaseId: c.phase }));
  tasks.push({ id: "integrate", title: "Verify complete delivery", requirementIds: ["R1"], dependsOn: tasks.map(t => t.id), allowedPaths: [], phaseId: "validate" });
  replaceWorkPlan(state, tasks, [
    { id: "design", title: "Architecture", dependsOn: [], exitRequirementIds: ["R2"] },
    { id: "build", title: "Implementation", dependsOn: ["design"], exitRequirementIds: item.criteria.filter(c => c.phase === "build").map(c => c.id) },
    { id: "validate", title: "Validation", dependsOn: ["build"], exitRequirementIds: [...item.criteria.filter(c => c.phase === "validate").map(c => c.id), "R1"] },
  ]);
  state.decisions.push({ id: item.decision.id, title: item.decision.accepted, rationale: item.decision.rationale, alternatives: Object.keys(item.decision.options).filter(id => id !== item.decision.accepted), paths: [] });
  return state;
}

export const planningCorpusHash = (): string => createHash("sha256").update(JSON.stringify({ version: PLANNING_CORPUS_VERSION, cases: planningCorpus() })).digest("hex");
