import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DecisionRecord, EvidenceReceipt, Requirement, WorkState, WorkTask, WorkPhase } from "./WorkTypes.js";

const timestamp = (): string => new Date().toISOString();
const assert = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
const unique = (values: string[], label: string): void => {
  assert(values.every(v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v)), `Invalid ${label} id`);
  assert(new Set(values).size === values.length, `Duplicate ${label} id`);
};
const taskDependencies = (state: WorkState, task: WorkTask): string[] => {
  const phase = state.phases?.find(p => p.id === task.phaseId);
  return [...new Set([...task.dependsOn, ...state.tasks.filter(t => t.phaseId && phase?.dependsOn.includes(t.phaseId)).map(t => t.id)])];
};
const dependenciesVerified = (state: WorkState, task: WorkTask): boolean =>
  taskDependencies(state, task).every(id => state.tasks.find(t => t.id === id)?.status === "verified");
const reopenTask = (task: WorkTask): void => {
  task.status = "planned"; task.evidenceIds = []; task.attemptId = undefined; task.leaseExpiresAt = undefined;
};
export const createWorkState = (objective: string, requirements?: Requirement[]): WorkState => {
  assert(objective.trim(), "Objective is required");
  const at = timestamp();
  const criteria = requirements ?? [{ id: "R1", description: objective, required: true }];
  const state: WorkState = {
    schemaVersion: 1, revision: 1, goalRevision: 1, goalId: randomUUID(), originalObjective: objective,
    objective, requirements: criteria, constraints: [], nonGoals: [], decisions: [], evidence: [], checkpoints: [], amendments: [],
    createdAt: at, updatedAt: at, status: "active", phases: [], planRevision: 1, planHistory: [],
    tasks: [{ id: "T1", title: objective, requirementIds: criteria.map(c => c.id), dependsOn: [], allowedPaths: [], status: "ready", evidenceIds: [] }],
  };
  validateWorkState(state);
  return state;
};

export const validateWorkState = (state: WorkState): void => {
  assert(state.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision > 0 && Number.isSafeInteger(state.goalRevision) && state.goalRevision > 0, "Unsupported/invalid work-state revision");
  assert(typeof state.objective === "string" && state.objective.trim() && typeof state.originalObjective === "string" && state.originalObjective.trim(), "Missing work objective");
  assert(["active", "blocked", "cancelled", "completed"].includes(state.status), "Invalid goal status");
  for (const key of ["requirements", "tasks", "decisions", "evidence", "checkpoints", "amendments", "constraints", "nonGoals"] as const) assert(Array.isArray(state[key]), `Invalid ${key}`);
  unique(state.requirements.map(r => r.id), "requirement");
  unique(state.tasks.map(t => t.id), "task");
  unique(state.decisions.map(d => d.id), "decision");
  unique(state.evidence.map(e => e.id), "evidence");
  assert(state.requirements.length > 0, "At least one acceptance criterion is required");
  const tasks = new Map(state.tasks.map(t => [t.id, t]));
  const requirements = new Set(state.requirements.map(r => r.id));
  const evidence = new Map(state.evidence.map(e => [e.id, e]));
  const phases = state.phases ?? [];
  assert(Array.isArray(phases) && (state.planRevision === undefined || Number.isSafeInteger(state.planRevision) && state.planRevision > 0), "Invalid plan revision/phases");
  unique(phases.map(p => p.id), "phase");
  for (const phase of phases) {
    assert(typeof phase.title === "string" && phase.title.trim(), `Phase ${phase.id}: missing title`);
    assert(Array.isArray(phase.dependsOn) && phase.dependsOn.every(id => id !== phase.id && phases.some(p => p.id === id)), `Phase ${phase.id}: missing/self dependency`);
    assert(Array.isArray(phase.exitRequirementIds) && phase.exitRequirementIds.length > 0 && phase.exitRequirementIds.every(id => requirements.has(id)), `Phase ${phase.id}: invalid exit criteria`);
    assert(state.tasks.some(t => t.phaseId === phase.id), `Phase ${phase.id}: no tasks`);
    assert(phase.exitRequirementIds.every(id => state.tasks.some(t => t.phaseId === phase.id && t.requirementIds.includes(id))), `Phase ${phase.id}: uncovered exit criterion`);
  }
  for (const r of state.requirements) assert(typeof r.description === "string" && r.description.trim() && typeof r.required === "boolean", "Invalid acceptance criterion");
  for (const task of state.tasks) {
    assert(typeof task.title === "string" && task.title.trim(), `Task ${task.id}: missing title`);
    assert(["planned", "ready", "running", "review_pending", "verified", "blocked", "cancelled", "superseded"].includes(task.status), `Task ${task.id}: invalid status`);
    assert(Array.isArray(task.dependsOn) && Array.isArray(task.requirementIds) && Array.isArray(task.allowedPaths) && Array.isArray(task.evidenceIds), `Task ${task.id}: invalid arrays`);
    assert(task.requirementIds.length > 0 && task.requirementIds.every(r => requirements.has(r)), `Task ${task.id}: unknown/missing requirement`);
    assert(task.dependsOn.every(id => tasks.has(id) && id !== task.id), `Task ${task.id}: missing/self dependency`);
    assert(!task.phaseId || phases.some(p => p.id === task.phaseId), `Task ${task.id}: unknown phase`);
    for (const file of task.allowedPaths) assert(typeof file === "string" && !path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."), `Task ${task.id}: invalid path`);
    assert(task.evidenceIds.every(id => evidence.get(id)?.taskId === task.id), `Task ${task.id}: invalid evidence reference`);
  }
  const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (id: string): void => {
    assert(!visiting.has(id), `Task dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const task = tasks.get(id)!;
    const phase = phases.find(p => p.id === task.phaseId);
    const dependencies = [...task.dependsOn, ...state.tasks.filter(t => t.phaseId && phase?.dependsOn.includes(t.phaseId)).map(t => t.id)];
    for (const dep of dependencies) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const task of state.tasks) visit(task.id);
  for (const criterion of state.requirements.filter(r => r.required)) {
    assert(state.tasks.some(t => !["cancelled", "superseded"].includes(t.status) && t.requirementIds.includes(criterion.id)), `Uncovered requirement: ${criterion.id}. Link this existing ID in task.requirementIds rather than inventing a replacement. Put whole-request R1 on the final integration task.`);
  }
};

export const refreshReadyTasks = (state: WorkState): void => {
  for (const task of state.tasks) if (task.status === "planned" || task.status === "ready") {
    task.status = dependenciesVerified(state, task) ? "ready" : "planned";
  }
};

export const replaceWorkPlan = (state: WorkState, tasks: Array<Pick<WorkTask, "id" | "title" | "requirementIds" | "dependsOn" | "allowedPaths" | "phaseId">>, phases = state.phases ?? [], reason = "Task plan refined"): void => {
  assert(!state.tasks.some(t => ["running", "review_pending"].includes(t.status)), "Finish the current attempt or call work_release with its taskId and attemptId before replacing the plan");
  const existing = new Map(state.tasks.map(t => [t.id, t]));
  const next = tasks.map(t => {
    const old = existing.get(t.id);
    if (old?.status === "verified") {
      assert(JSON.stringify([old.title, old.requirementIds, old.dependsOn, old.allowedPaths, old.phaseId]) === JSON.stringify([t.title, t.requirementIds, t.dependsOn, t.allowedPaths, t.phaseId]), `Cannot silently rewrite verified task ${t.id}`);
      return old;
    }
    return { ...t, status: "planned" as const, evidenceIds: [] };
  });
  for (const old of state.tasks.filter(t => t.status === "verified")) assert(next.some(t => t.id === old.id), `Cannot remove verified task ${old.id}`);
  const candidate = { ...state, tasks: next, phases };
  validateWorkState(candidate);
  const phaseContract = (all: WorkPhase[], id?: string): WorkPhase[] => {
    const selected = new Map<string, WorkPhase>();
    const add = (phaseId: string): void => {
      const phase = all.find(p => p.id === phaseId);
      if (!phase || selected.has(phaseId)) return;
      selected.set(phaseId, phase); phase.dependsOn.forEach(add);
    };
    if (id) add(id);
    return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  for (const task of next.filter(t => t.status === "verified")) {
    assert(JSON.stringify(phaseContract(state.phases ?? [], task.phaseId)) === JSON.stringify(phaseContract(phases, task.phaseId)), `Cannot silently rewrite the phase contract of verified task ${task.id}`);
    assert(dependenciesVerified(candidate, task), `Verified task ${task.id} has an unverified prerequisite in the revised plan`);
  }
  state.planHistory ??= [];
  state.planHistory.push({ revision: state.planRevision ?? 1, goalRevision: state.goalRevision, at: timestamp(), reason, tasks: structuredClone(state.tasks), phases: structuredClone(state.phases ?? []) });
  state.planRevision = (state.planRevision ?? 1) + 1;
  state.tasks = next; state.phases = structuredClone(phases); refreshReadyTasks(state);
};

export const claimWorkTask = (state: WorkState, taskId: string, leaseMs = 300_000): WorkTask => {
  assert(state.status === "active", "Goal is not active");
  refreshReadyTasks(state);
  const task = state.tasks.find(t => t.id === taskId);
  assert(task?.status === "ready", "Task is not ready");
  assert(!state.tasks.some(t => ["running", "review_pending"].includes(t.status)), "A task already owns this workspace");
  assert(Number.isFinite(leaseMs) && leaseMs > 0, "Invalid lease");
  task!.status = "running"; task!.attemptId = randomUUID(); task!.goalRevision = state.goalRevision;
  task!.planRevision = state.planRevision ?? 1;
  task!.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  return task!;
};

export const releaseWorkTask = (state: WorkState, taskId: string, attemptId: string, note: string): void => {
  const task = state.tasks.find(t => t.id === taskId);
  assert(task && ["running", "review_pending"].includes(task.status) && task.attemptId === attemptId, "Cannot release a stale or inactive task attempt");
  assert(note.trim(), "Explain why the attempt is released and what changes next");
  state.checkpoints.push({ id: randomUUID(), at: timestamp(), goalRevision: state.goalRevision,
    activeTaskId: taskId, note: `Released attempt ${attemptId}: ${note}`, uncertainInvocationIds: [] });
  reopenTask(task!); refreshReadyTasks(state);
};

/** Withdraw a disproven verification and fence all dependent attempts without rewriting the plan. */
export const reopenVerifiedTask = (state: WorkState, taskId: string, reason: string): string[] => {
  const task = state.tasks.find(t => t.id === taskId);
  assert(state.status === "active" && task?.status === "verified", "Only a verified task in an active goal can be reopened");
  assert(reason.trim(), "Explain the new evidence that disproves this verification");
  const affected = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of state.tasks) if (!affected.has(candidate.id) && !["cancelled", "superseded"].includes(candidate.status)
      && taskDependencies(state, candidate).some(id => affected.has(id))) {
      affected.add(candidate.id); changed = true;
    }
  }
  for (const candidate of state.tasks) if (affected.has(candidate.id)) reopenTask(candidate);
  state.checkpoints.push({ id: randomUUID(), at: timestamp(), goalRevision: state.goalRevision,
    activeTaskId: taskId, note: `Reopened verified task ${taskId}; invalidated ${[...affected].join(", ")}: ${reason}`, uncertainInvocationIds: [] });
  refreshReadyTasks(state);
  return [...affected];
};

export const assertWorkAttempt = (state: WorkState, taskId: string, attemptId: string): WorkTask => {
  const task = state.tasks.find(t => t.id === taskId);
  assert(state.status === "active" && task && ["running", "review_pending"].includes(task.status) && task.attemptId === attemptId && task.goalRevision === state.goalRevision, "Stale task attempt or goal revision");
  assert(Date.parse(task!.leaseExpiresAt ?? "") > Date.now(), "Task lease expired; reconcile before retrying");
  assert(task!.planRevision === undefined || task!.planRevision === (state.planRevision ?? 1), "Stale plan revision");
  assert(dependenciesVerified(state, task!), "Task prerequisite was invalidated; reconcile before continuing");
  return task!;
};

export const recordWorkEvidence = (state: WorkState, taskId: string, attemptId: string, evidence: EvidenceReceipt): void => {
  const task = assertWorkAttempt(state, taskId, attemptId);
  assert(evidence.taskId === taskId && evidence.criterionIds.length > 0 && evidence.criterionIds.every(id => task.requirementIds.includes(id)), "Evidence does not match the task criteria");
  assert(evidence.kind !== "tool" || evidence.invocationId, "Tool evidence requires an invocation receipt");
  const previous = state.evidence.find(e => e.id === evidence.id);
  if (previous) { assert(JSON.stringify(previous) === JSON.stringify(evidence), "Conflicting evidence id"); return; }
  state.evidence.push(evidence); task.evidenceIds.push(evidence.id); task.status = "review_pending";
};

export const verifyWorkTask = (state: WorkState, taskId: string, attemptId: string, currentHashes: Record<string, string>): void => {
  const task = assertWorkAttempt(state, taskId, attemptId);
  const applicable = state.evidence.filter(e => task.evidenceIds.includes(e.id) && e.ok && Object.entries(e.inputHashes).every(([file, hash]) => currentHashes[file] === hash));
  for (const requirement of task.requirementIds) assert(applicable.some(e => e.criterionIds.includes(requirement)), `Unverified/stale criterion: ${requirement}`);
  task.status = "verified"; refreshReadyTasks(state);
};

/** Reopen stale proofs and their dependent tasks without discarding audit history. */
export const refreshStaleEvidence = (state: WorkState, currentHashes: Record<string, string>): string[] => {
  const reopened: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of state.tasks.filter(t => ["verified", "running", "review_pending"].includes(t.status))) {
      const proofs = state.evidence.filter(e => task.evidenceIds.includes(e.id) && e.ok && Object.entries(e.inputHashes).every(([file, hash]) => currentHashes[file] === hash));
      if ((task.status !== "verified" || task.requirementIds.every(id => proofs.some(e => e.criterionIds.includes(id)))) && dependenciesVerified(state, task)) continue;
      reopenTask(task);
      reopened.push(task.id); changed = true;
    }
  }
  if (reopened.length && state.status === "completed") state.status = "active";
  refreshReadyTasks(state);
  return reopened;
};

export const amendWorkGoal = (state: WorkState, objective: string, reason: string): void => {
  assert(objective.trim() && reason.trim(), "Goal amendment needs an objective and reason");
  state.amendments.push({ revision: state.goalRevision, at: timestamp(), reason, previousObjective: state.objective });
  state.goalRevision += 1; state.objective = objective; state.status = "active";
  const criterionId = `steering-${state.goalRevision}`;
  state.requirements.push({ id: criterionId, description: reason, required: true });
  state.tasks.push({ id: criterionId, title: reason, requirementIds: [criterionId], dependsOn: [], allowedPaths: [], status: "planned", evidenceIds: [] });
  for (const task of state.tasks) if (!["cancelled", "superseded"].includes(task.status)) {
    task.status = "planned"; task.attemptId = undefined; task.leaseExpiresAt = undefined; task.evidenceIds = [];
  }
  refreshReadyTasks(state);
};

export const recordDecision = (state: WorkState, decision: DecisionRecord): void => {
  assert(decision.title.trim() && decision.rationale.trim(), "Decision requires a title and rationale");
  assert(!state.decisions.some(d => d.id === decision.id), "Decision id already exists");
  if (decision.supersedes) assert(state.decisions.some(d => d.id === decision.supersedes), "Superseded decision does not exist");
  if (decision.supersedes) assert(!state.decisions.some(d => d.supersedes === decision.supersedes), "Decision was already superseded; supersede its current replacement");
  state.decisions.push(decision);
  if (decision.supersedes) {
    const previous = state.decisions.find(d => d.id === decision.supersedes)!;
    const affected = [...previous.paths, ...decision.paths];
    const invalidated = new Set<string>();
    for (const task of state.tasks) if (["verified", "running", "review_pending"].includes(task.status) && (!affected.length || !task.allowedPaths.length || task.allowedPaths.some(scope => affected.some(file => scope === "." || file === scope || file.startsWith(`${scope}/`) || scope.startsWith(`${file}/`))))) {
      reopenTask(task); invalidated.add(task.id);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of state.tasks) if (!invalidated.has(task.id) && !["cancelled", "superseded"].includes(task.status) && taskDependencies(state, task).some(id => invalidated.has(id))) {
        reopenTask(task); invalidated.add(task.id); changed = true;
      }
    }
    if (invalidated.size && state.status === "completed") state.status = "active";
    refreshReadyTasks(state);
  }
};

export const completeWorkGoal = (state: WorkState, currentHashes: Record<string, string>, uncertainInvocationIds: string[] = []): void => {
  validateWorkState(state);
  assert(state.status === "active" && uncertainInvocationIds.length === 0, "Goal cannot complete with unresolved side effects");
  assert(state.tasks.every(t => ["verified", "cancelled", "superseded"].includes(t.status)), "Required task work remains");
  for (const criterion of state.requirements.filter(r => r.required)) {
    const tasks = state.tasks.filter(t => t.requirementIds.includes(criterion.id) && t.status === "verified");
    assert(tasks.length > 0 && tasks.every(t => state.evidence.some(e => t.evidenceIds.includes(e.id) && e.ok && e.criterionIds.includes(criterion.id) && Object.entries(e.inputHashes).every(([file, hash]) => currentHashes[file] === hash))), `Unverified/stale criterion: ${criterion.id}`);
  }
  state.status = "completed";
};

export const workContext = (state: WorkState): string => JSON.stringify({
  goalId: state.goalId, goalRevision: state.goalRevision, planRevision: state.planRevision ?? 1, phases: state.phases ?? [], objective: state.objective,
  originalObjective: state.originalObjective, requirements: state.requirements, constraints: state.constraints,
  nonGoals: state.nonGoals, tasks: state.tasks.map(t => ({ id: t.id, title: t.title, phaseId: t.phaseId, status: t.status, dependsOn: t.dependsOn, requirementIds: t.requirementIds, allowedPaths: t.allowedPaths, attemptId: t.attemptId, blocker: t.blocker })),
  decisions: state.decisions, checkpoint: state.checkpoints.at(-1),
});

/** Keep the active contract intact while paging unrelated backlog out of context. */
export const activeWorkContext = (state: WorkState, maxChars: number): string => {
  const full = workContext(state);
  if (full.length <= maxChars) return full;
  const active = state.tasks.find(t => ["running", "review_pending"].includes(t.status)) ?? state.tasks.find(t => t.status === "ready");
  const requiredIds = new Set(active?.requirementIds ?? []);
  const superseded = new Set(state.decisions.map(d => d.supersedes).filter(Boolean));
  const relevant = (paths: string[]) => !active || !paths.length || !active.allowedPaths.length || paths.some(file => active.allowedPaths.some(scope => scope === "." || file === scope || file.startsWith(`${scope}/`) || scope.startsWith(`${file}/`)));
  const currentDecisions = state.decisions.filter(d => !superseded.has(d.id) && relevant(d.paths));
  const view = {
    goalId: state.goalId, goalRevision: state.goalRevision, planRevision: state.planRevision ?? 1,
    objective: state.objective, originalObjective: state.originalObjective, constraints: state.constraints, nonGoals: state.nonGoals,
    activeTask: active,
    requirements: state.requirements.filter(r => requiredIds.has(r.id)),
    decisions: currentDecisions,
    phases: state.phases?.filter(p => p.id === active?.phaseId),
    prerequisiteTasks: active ? taskDependencies(state, active).map(id => {
      const task = state.tasks.find(t => t.id === id)!; return { id, title: task.title, status: task.status };
    }) : [],
    taskCounts: Object.fromEntries([...new Set(state.tasks.map(t => t.status))].map(status => [status, state.tasks.filter(t => t.status === status).length])),
    totalRequirements: state.requirements.length,
    otherRequirements: [] as Array<{ id: string; description: string; required: boolean }>,
    nextTasks: [] as Array<{ id: string; title: string; status: string }>,
    contextPartial: true,
    continuation: "The complete goal and backlog remain canonical in storage. Use work_status with offset/limit or taskIds/requirementIds to retrieve omitted records. Claiming a task loads its full criteria and relevant decisions. Completion still checks every required criterion.",
  };
  const encode = () => JSON.stringify(view);
  if (encode().length > maxChars) throw new Error("Active goal, constraints, architecture decisions and criteria exceed the context reservation; use a larger compatible model context or split the active task");
  for (const requirement of state.requirements.filter(r => !requiredIds.has(r.id))) {
    view.otherRequirements.push(requirement);
    if (encode().length > maxChars) { view.otherRequirements.pop(); break; }
  }
  for (const task of state.tasks.filter(t => t.id !== active?.id && !["verified", "cancelled", "superseded"].includes(t.status))) {
    view.nextTasks.push({ id: task.id, title: task.title, status: task.status });
    if (encode().length > maxChars) { view.nextTasks.pop(); break; }
  }
  return encode();
};
