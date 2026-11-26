import type { WorkState } from "../session/WorkTypes.js";

/** A stopped turn is not a delivery. Summarize only durable state, without inference. */
/** Files changed during a call that failed on a workspace conflict and not read or written since. */
export const unreconciledNote = (files: string[]): string => `Files changed during a failed tool call and not inspected since (they may hold another process's edits): ${files.slice(0, 8).join(", ")}${files.length > 8 ? `; ${files.length - 8} more` : ""}. Review them before relying on this result.`;

export function interruptedReport(state: WorkState, sessionId: string, touched: string[], uncertain: string[], unreconciled: string[] = []): string {
  const pending = state.tasks.filter(task => !["verified", "cancelled", "superseded"].includes(task.status));
  const verified = state.tasks.filter(task => task.status === "verified").length;
  const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 180);
  const lines = ["Work is incomplete; the original requirements and checkpoint are retained.",
    `Recorded verification: ${verified} task(s). Remaining: ${pending.length} task(s).`,
    ...pending.slice(0, 6).map(task => `- ${task.id} [${task.status}]: ${short(task.title)}${task.blocker ? ` — ${short(task.blocker)}` : ""}`)];
  if (pending.length > 6) lines.push(`${pending.length - 6} more tasks are retained in /status.`);
  if (touched.length) lines.push(`Changed files (not a completion claim): ${touched.slice(0, 8).map(short).join(", ")}${touched.length > 8 ? `; ${touched.length - 8} more` : ""}.`);
  if (uncertain.length) lines.push(`${uncertain.length} operation outcome(s) need reconciliation before retrying.`);
  if (unreconciled.length) lines.push(unreconciledNote(unreconciled));
  lines.push(`Resume this session with /resume ${sessionId}, then /continue. Inspect /status and /usage for details.`);
  return lines.join("\n");
}

/** What a turn that ran out of time hands back: recorded state only, with the
 * latest check as it was observed. */
export function deadlineReport(handoff: string, latestCheck?: { command: string; status: string }): string {
  return ["The time limit was reached before the goal passed its completion gate. This is a status report, not a completion claim.",
    handoff,
    latestCheck ? `Latest recorded check: ${latestCheck.command} ended with status ${latestCheck.status}.` : "No test, build or lint check was recorded.",
  ].join("\n");
}

/** Delivery repeats accepted evidence instead of asking the model to introduce
 * new factual claims after the goal has already passed review. */
export function completionReport(state: WorkState, budgetExhausted = false, unreconciled: string[] = []): string {
  const accepted = new Set(state.tasks.filter(task => task.status === "verified").flatMap(task => task.evidenceIds));
  const summaries = [...new Set(state.evidence.filter(item => accepted.has(item.id) && item.kind === "review" && item.ok)
    .map(item => item.summary.trim()).filter(Boolean))];
  const heading = state.projectTask ? "Execution verified and submitted for mcoda review." : "Required work completed with recorded verification evidence.";
  const selected = summaries.slice(-5).map(summary => summary.length <= 2000 ? summary : summary.slice(0, 2000) + "\n[Summary shortened; full evidence is retained in the session.]");
  const more = summaries.length > selected.length ? `\n\n${summaries.length - selected.length} additional accepted task summaries are retained in the session.` : "";
  return heading + (selected.length ? "\n\n" + selected.join("\n\n") : "") + more
    + (budgetExhausted ? "\n\nThe model budget was exhausted; this report uses the recorded verification evidence." : "")
    + (unreconciled.length ? `\n\n${unreconciledNote(unreconciled)}` : "");
}
