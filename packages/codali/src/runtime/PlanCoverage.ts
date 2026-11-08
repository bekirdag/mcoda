/** Preserve an omitted canonical root obligation on an unambiguous final task.
 * The normal validator still rejects cycles, unknown IDs and uncovered criteria.
 * Use only for complete replacement plans, never partial updates. */
export function retainRootCoverage<T extends { id: string; requirementIds: string[]; dependsOn: string[] }>(tasks: T[], rootId: string): T[] {
  if (tasks.some(task => task.requirementIds.includes(rootId))) return tasks;
  const dependedUpon = new Set(tasks.flatMap(task => task.dependsOn));
  const terminal = tasks.filter(task => !dependedUpon.has(task.id));
  if (terminal.length !== 1) return tasks;
  return tasks.map(task => task === terminal[0] ? { ...task, requirementIds: [...task.requirementIds, rootId] } : task);
}
