import { createHash } from "node:crypto";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;

/** Counts unchanged local operations, not wall-clock-dependent tool diagnostics.
 * A changed input or task attempt gets its own counter. Controls/remote polling
 * are excluded: repetition alone does not prove those operations stalled. */
export class ProgressTracker {
  private counts = new Map<string, number>();
  clear(): void { this.counts.clear(); }
  observe(input: { tool: string; args: unknown; ok: boolean; hashes: Record<string, string>; task?: unknown; output: string; errorCode?: string }): number {
    if (!["read_file", "list_files", "run_shell"].includes(input.tool) || input.ok && input.tool === "run_shell") return 0;
    const signature = createHash("sha256").update(JSON.stringify(canonical({
      tool: input.tool, args: input.args, ok: input.ok, hashes: input.hashes, task: input.task,
      // File/list results can change without a prior snapshot, e.g. a user edit.
      observed: input.ok ? createHash("sha256").update(input.output).digest("hex") : input.errorCode,
    }))).digest("hex");
    const count = (this.counts.get(signature) ?? 0) + 1;
    this.counts.delete(signature); this.counts.set(signature, count);
    if (this.counts.size > 512) this.counts.delete(this.counts.keys().next().value!);
    return count;
  }
}
