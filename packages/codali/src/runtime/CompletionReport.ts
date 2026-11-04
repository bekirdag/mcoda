import type { WorkState } from "../session/WorkTypes.js";

/** Delivery repeats accepted evidence instead of asking the model to introduce
 * new factual claims after the goal has already passed review. */
export function completionReport(state: WorkState, budgetExhausted = false): string {
  const accepted = new Set(state.tasks.filter(task => task.status === "verified").flatMap(task => task.evidenceIds));
  const summaries = [...new Set(state.evidence.filter(item => accepted.has(item.id) && item.kind === "review" && item.ok)
    .map(item => item.summary.trim()).filter(Boolean))];
  const heading = state.projectTask ? "Execution verified and submitted for mcoda review." : "Required work completed with recorded verification evidence.";
  const selected = summaries.slice(-5).map(summary => summary.length <= 2000 ? summary : summary.slice(0, 2000) + "\n[Summary shortened; full evidence is retained in the session.]");
  const more = summaries.length > selected.length ? `\n\n${summaries.length - selected.length} additional accepted task summaries are retained in the session.` : "";
  return heading + (selected.length ? "\n\n" + selected.join("\n\n") : "") + more
    + (budgetExhausted ? "\n\nThe model budget was exhausted; this report uses the recorded verification evidence." : "");
}
