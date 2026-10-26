import type { WorkState, WorkTask } from "../session/WorkTypes.js";
import { isTestSourcePath } from "./RequestedTestEvidence.js";
import { isWithinScope } from "./StructuralEvidence.js";

/** Scope the review question without weakening the controller's global freshness checks. */
export function taskReviewContext(state: WorkState, task: WorkTask, input: {
  changedPaths: string[];
  observedPaths: string[];
  contextPaths: string[];
  currentHashes: Record<string, string>;
}) {
  const requirements = state.requirements.filter(requirement => task.requirementIds.includes(requirement.id));
  const wholeGoal = requirements.some(requirement => requirement.description === state.originalObjective);
  const inScope = (file: string) => wholeGoal || isWithinScope(file, task.allowedPaths);
  const changedPaths = input.changedPaths.filter(inScope);
  const reviewPaths = [...new Set([
    ...changedPaths,
    ...Object.keys(input.currentHashes).filter(file => inScope(file) && isTestSourcePath(file)),
    ...input.observedPaths.filter(inScope),
    ...input.contextPaths,
  ])];
  const superseded = new Set(state.decisions.map(decision => decision.supersedes).filter(Boolean));
  const decisions = state.decisions.filter(decision => !superseded.has(decision.id) && (wholeGoal || !decision.paths.length
    || decision.paths.some(file => isWithinScope(file, task.allowedPaths)
      || task.allowedPaths.some(scope => isWithinScope(scope, [file]))
      || reviewPaths.some(observed => isWithinScope(observed, [file])))));
  return {
    reviewScope: wholeGoal ? "whole_goal" : "assigned_task",
    goal: wholeGoal ? state.objective : undefined,
    goalReference: { id: state.goalId, revision: state.goalRevision, planRevision: state.planRevision ?? 1 },
    requirements, constraints: state.constraints, nonGoals: state.nonGoals, decisions,
    deferredRequirements: wholeGoal ? [] : state.requirements.filter(requirement => !task.requirementIds.includes(requirement.id))
      .map(requirement => ({ id: requirement.id, owners: state.tasks.filter(owner => owner.requirementIds.includes(requirement.id)
        && !["cancelled", "superseded"].includes(owner.status)).map(owner => ({ taskId: owner.id, status: owner.status })) })),
    changedPaths,
    otherTaskChangedPaths: input.changedPaths.filter(file => !inScope(file)),
    reviewPaths,
    sourceRoles: Object.fromEntries(reviewPaths.map(file => [file, changedPaths.includes(file) ? "reviewed_change"
      : inScope(file) ? "scope_context" : "read_only_context"])),
  };
}
