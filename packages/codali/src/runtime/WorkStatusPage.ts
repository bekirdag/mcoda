import type { WorkState } from "../session/WorkTypes.js";

export interface WorkStatusQuery {
  offset?: number;
  limit?: number;
  taskIds?: string[];
  requirementIds?: string[];
  record?: "goal" | "task" | "requirement" | "decision" | "phase" | "constraints";
  recordId?: string;
  textOffset?: number;
  textLimit?: number;
}

/** Inspection must remain available even when the whole goal cannot fit in a
 * model context. Previews are explicit; record chunks retrieve the exact JSON. */
export function workStatusPage(state: WorkState, query: WorkStatusQuery): Record<string, unknown> {
  const offset = query.offset ?? 0, limit = query.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid status page");
  if (query.record) {
    const record = query.record === "goal" ? { goalId: state.goalId, goalRevision: state.goalRevision, originalObjective: state.originalObjective, objective: state.objective }
      : query.record === "constraints" ? { constraints: state.constraints, nonGoals: state.nonGoals }
      : (() => {
        const records = query.record === "task" ? state.tasks : query.record === "requirement" ? state.requirements : query.record === "decision" ? state.decisions : state.phases ?? [];
        return query.recordId ? records.find(item => item.id === query.recordId) : records;
      })();
    if (!record) throw new Error("Unknown status record; supply its exact recordId");
    const encoded = JSON.stringify(record), start = query.textOffset ?? 0, size = query.textLimit ?? 6000;
    if (!Number.isSafeInteger(start) || start < 0 || start > encoded.length || !Number.isSafeInteger(size) || size < 1 || size > 6000) throw new Error("Invalid status record text range");
    const content = encoded.slice(start, start + size);
    return { record: query.record, recordId: query.recordId, encoding: "json", content, textOffset: start,
      totalChars: encoded.length, nextTextOffset: start + content.length < encoded.length ? start + content.length : null };
  }
  const tasks = state.tasks.filter(task => !query.taskIds || query.taskIds.includes(task.id));
  const candidates = tasks.slice(offset, offset + limit);
  const ids = new Set(query.requirementIds ?? candidates.flatMap(task => task.requirementIds));
  const requirements = state.requirements.filter(requirement => ids.has(requirement.id));
  const view = {
    goalId: state.goalId, goalRevision: state.goalRevision, planRevision: state.planRevision ?? 1, status: state.status,
    originalObjective: state.originalObjective.slice(0, 1200), originalObjectiveTruncated: state.originalObjective.length > 1200,
    objective: state.objective.slice(0, 1200), objectiveTruncated: state.objective.length > 1200,
    tasks: [] as unknown[], requirements: [] as unknown[],
    totalTasks: tasks.length, totalRequirements: state.requirements.length,
    totalDecisions: state.decisions.length, totalPhases: state.phases?.length ?? 0,
    totalConstraints: state.constraints.length, totalNonGoals: state.nonGoals.length,
    nextOffset: null as number | null, omittedRequirements: 0,
    continuation: "This is a bounded inspection page, not the complete contract. Use offset/limit or taskIds/requirementIds for records. Use record:goal|constraints|task|requirement|decision|phase, recordId and textOffset to retrieve exact JSON in chunks. Every canonical requirement remains mandatory.",
  };
  const preview = (item: { id: string; [key: string]: unknown }) => JSON.stringify(item).length <= 2500 ? item
    : { id: item.id, status: item.status, title: typeof item.title === "string" ? item.title.slice(0, 240) : undefined,
      description: typeof item.description === "string" ? item.description.slice(0, 600) : undefined, recordTruncated: true };
  for (const task of candidates) {
    view.tasks.push(preview({ ...task }));
    if (JSON.stringify(view).length > 9000) { view.tasks.pop(); break; }
  }
  view.nextOffset = offset + view.tasks.length < tasks.length ? offset + view.tasks.length : null;
  for (const requirement of requirements) {
    view.requirements.push(preview({ ...requirement }));
    if (JSON.stringify(view).length > 12_000) { view.requirements.pop(); break; }
  }
  view.omittedRequirements = requirements.length - view.requirements.length;
  return view;
}
