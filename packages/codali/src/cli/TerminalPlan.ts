import type { WorkState, WorkTask, WorkPhase } from "../session/WorkTypes.js";

const taskContract = (task: WorkTask) => ({
  id: task.id, title: task.title, phaseId: task.phaseId,
  requirementIds: [...task.requirementIds].sort(), dependsOn: [...task.dependsOn].sort(), allowedPaths: [...task.allowedPaths].sort(),
});
const phaseContract = (phase: WorkPhase) => ({
  id: phase.id, title: phase.title, dependsOn: [...phase.dependsOn].sort(), exitRequirementIds: [...phase.exitRequirementIds].sort(),
});
const differences = <T extends { id: string }>(before: T[], after: T[]): Array<{ id: string; before?: T; after?: T }> => {
  const old = new Map(before.map(item => [item.id, item]));
  const next = new Map(after.map(item => [item.id, item]));
  return [...new Set([...old.keys(), ...next.keys()])].sort()
    .filter(id => JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id)))
    .map(id => ({ id, before: old.get(id), after: next.get(id) }));
};

export const inspectPlanDiff = (state: WorkState, from?: number, to?: number) => {
  const current = state.planRevision ?? 1;
  const history = state.planHistory ?? [];
  const toRevision = to ?? current;
  const previous = history.filter(item => item.revision < toRevision).reduce((latest, item) => Math.max(latest, item.revision), 0);
  const fromRevision = from ?? (previous || toRevision);
  const snapshot = (revision: number) => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Plan revisions must be positive integers");
    if (revision === current) return { tasks: state.tasks, phases: state.phases ?? [] };
    const saved = history.find(item => item.revision === revision);
    if (!saved) throw new Error(`Unknown plan revision ${revision}`);
    return saved;
  };
  const before = snapshot(fromRevision); const after = snapshot(toRevision);
  return { fromRevision, toRevision,
    tasks: differences(before.tasks.map(taskContract), after.tasks.map(taskContract)),
    phases: differences(before.phases.map(phaseContract), after.phases.map(phaseContract)),
  };
};
