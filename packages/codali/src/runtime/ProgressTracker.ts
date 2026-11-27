import { createHash } from "node:crypto";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;

/** Counts unchanged local operations, not wall-clock-dependent tool diagnostics.
 * A changed input or task attempt gets its own counter. Controls/remote polling
 * are excluded: repetition alone does not prove those operations stalled. */
export class ProgressTracker {
  private counts = new Map<string, { count: number; feedbackRound?: number }>();
  clear(): void { this.counts.clear(); }
  observe(input: { tool: string; args: unknown; ok: boolean; hashes: Record<string, string>; task?: unknown; output: string; errorCode?: string; feedbackRound?: number }): number {
    if (!["read_file", "list_files", "prepare_edit", "run_shell"].includes(input.tool) || input.ok && input.tool === "run_shell") return 0;
    let args = input.args, observed = input.ok ? createHash("sha256").update(input.output).digest("hex") : input.errorCode;
    if (input.ok && input.tool === "prepare_edit") {
      const preparation = input.args as { path?: string; offset?: number; maxChars?: number };
      const file = preparation.path?.replace(/^\.\//, "");
      if (!file || !input.hashes[file]) return 0;
      // Internal read/analysis receipts change IDs on every preparation. Only
      // source bytes, requested span and task identity establish new evidence.
      observed = input.hashes[file];
      args = { path: file, offset: preparation.offset ?? 0, maxChars: preparation.maxChars };
    }
    const signature = createHash("sha256").update(JSON.stringify(canonical({
      tool: input.tool, args, ok: input.ok,
      // Successful reads/listings already fingerprint their actual result. The
      // observation inventory grows during discovery; unrelated reads must not
      // reset this counter. Failed operations retain their input dependencies.
      hashes: input.ok ? undefined : input.hashes, task: input.task,
      // File/list results can change without a prior snapshot, e.g. a user edit.
      observed,
    }))).digest("hex");
    const previous = this.counts.get(signature);
    // A batch can contain duplicate calls before the model has seen any result.
    // Count another retry only after it had an opportunity to consume feedback.
    if (input.feedbackRound !== undefined && previous?.feedbackRound === input.feedbackRound) return previous.count;
    const count = (previous?.count ?? 0) + 1;
    this.counts.delete(signature); this.counts.set(signature, { count, feedbackRound: input.feedbackRound });
    if (this.counts.size > 512) this.counts.delete(this.counts.keys().next().value!);
    return count;
  }
}
