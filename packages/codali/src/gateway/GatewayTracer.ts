/**
 * Minimal run tracing.
 *
 * This ships with the first executable version rather than being deferred to a
 * later observability phase. Tool-selection and iteration failures are the two
 * things most likely to go wrong in an orchestrator, and both are close to
 * undiagnosable without a record of what was chosen and why. Full trace replay
 * can wait; knowing which model ran, which tools it picked, and why the run
 * stopped cannot.
 *
 * Arguments are sanitized before they are recorded, because tool arguments
 * routinely carry tokens and paths that must not reach a log.
 */

export interface GatewayTraceRecord {
  runId?: string;
  query: string;
  startedAt: string;
  roleBindings: Record<string, string>;
  capabilities?: string[];
  plannedTasks: Array<{ id: string; role: string; objective: string; tools: string[] }>;
  toolCalls: Array<{
    taskId: string;
    tool: string;
    args: unknown;
    ok?: boolean;
    latencyMs?: number;
    errorCode?: string;
  }>;
  rounds: number;
  finalizerMode?: string;
  completionReason?: string;
  status?: string;
  durationMs?: number;
  warnings: string[];
}

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|api[_-]?key|bearer|credential|password|secret|signature|token)/i;

/**
 * Secret shapes redacted from *values*, not just from suspiciously named keys.
 *
 * A connector routinely returns a token inside an innocuously named field, and
 * an MCP tool's arguments are model-generated, so key-name matching alone is
 * not enough. These mirror the dataset privacy engine's patterns; both must
 * catch a leak, because the trace is what gets printed to a terminal and pasted
 * into an issue.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_[A-Za-z0-9]+_[A-Za-z0-9_]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export const redactSecretValues = (value: string): string => {
  let output = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
};

const MAX_ARG_STRING = 200;

/**
 * Redacts sensitive-looking values and truncates long ones. Applied to every
 * argument before it is recorded or printed.
 */
export const sanitizeArgs = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[depth limit]";
  if (typeof value === "string") {
    // Redact before truncating: truncation could otherwise cut a secret in half
    // and leave a recognizable prefix in the trace.
    const redacted = redactSecretValues(value);
    return redacted.length > MAX_ARG_STRING
      ? `${redacted.slice(0, MAX_ARG_STRING)}…`
      : redacted;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeArgs(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[redacted]"
        : sanitizeArgs(entry, depth + 1);
    }
    return output;
  }
  return value;
};

export interface GatewayTracerOptions {
  /** Print progress to stderr as the run proceeds. */
  verbose?: boolean;
  write?: (line: string) => void;
}

export class GatewayTracer {
  private readonly record: GatewayTraceRecord;
  private readonly startedMs = Date.now();

  constructor(query: string, private readonly options: GatewayTracerOptions = {}) {
    this.record = {
      query,
      startedAt: new Date().toISOString(),
      roleBindings: {},
      plannedTasks: [],
      toolCalls: [],
      rounds: 0,
      warnings: [],
    };
  }

  private emit(line: string): void {
    if (!this.options.verbose) return;
    (this.options.write ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
  }

  setRunId(runId: string): void {
    this.record.runId = runId;
  }

  setRoleBindings(bindings: Record<string, string | undefined>): void {
    for (const [role, slug] of Object.entries(bindings)) {
      if (slug) this.record.roleBindings[role] = slug;
    }
    const rendered = Object.entries(this.record.roleBindings)
      .map(([role, slug]) => `${role}=${slug}`)
      .join(" ");
    if (rendered) this.emit(`· agents: ${rendered}`);
  }

  recordPlan(input: {
    capabilities?: string[];
    tasks: Array<{ id: string; workerRole: string; objective: string; toolsAllowed?: string[] }>;
  }): void {
    this.record.capabilities = input.capabilities;
    this.record.plannedTasks = input.tasks.map((task) => ({
      id: task.id,
      role: task.workerRole,
      objective: task.objective,
      tools: task.toolsAllowed ?? [],
    }));
    if (input.capabilities?.length) {
      this.emit(`· capabilities: ${input.capabilities.join(", ")}`);
    }
    this.emit(
      this.record.plannedTasks.length === 0
        ? "· plan: answer directly, no tool tasks"
        : `· plan: ${this.record.plannedTasks.length} task(s)`,
    );
    for (const task of this.record.plannedTasks) {
      this.emit(`    ${task.id} [${task.role}] ${task.objective}`);
    }
  }

  recordToolCall(input: { taskId: string; tool: string; args: unknown }): void {
    this.record.toolCalls.push({
      taskId: input.taskId,
      tool: input.tool,
      args: sanitizeArgs(input.args),
    });
    this.emit(`· tool → ${input.tool} ${JSON.stringify(sanitizeArgs(input.args))}`);
  }

  recordToolResult(input: {
    taskId: string;
    tool: string;
    ok: boolean;
    latencyMs: number;
    errorCode?: string;
  }): void {
    // Attach to the most recent matching call rather than appending a row, so
    // the trace reads as one line per call.
    for (let index = this.record.toolCalls.length - 1; index >= 0; index -= 1) {
      const call = this.record.toolCalls[index];
      if (call && call.tool === input.tool && call.ok === undefined) {
        call.ok = input.ok;
        call.latencyMs = input.latencyMs;
        call.errorCode = input.errorCode;
        break;
      }
    }
    this.emit(
      `· tool ← ${input.tool} ${input.ok ? "ok" : `failed (${input.errorCode ?? "unknown"})`} ${input.latencyMs}ms`,
    );
  }

  recordRound(round: number): void {
    this.record.rounds = Math.max(this.record.rounds, round);
    this.emit(`· round ${round}`);
  }

  addWarning(warning: string): void {
    this.record.warnings.push(warning);
  }

  finish(input: {
    status: string;
    finalizerMode?: string;
    completionReason?: string;
    warnings?: string[];
  }): GatewayTraceRecord {
    this.record.status = input.status;
    this.record.finalizerMode = input.finalizerMode;
    this.record.completionReason = input.completionReason;
    this.record.warnings.push(...(input.warnings ?? []));
    this.record.durationMs = Date.now() - this.startedMs;
    this.emit(
      `· done: ${input.status}${
        input.finalizerMode ? ` via ${input.finalizerMode}` : ""
      } in ${this.record.durationMs}ms (${this.record.toolCalls.length} tool calls)`,
    );
    return this.record;
  }

  snapshot(): GatewayTraceRecord {
    return this.record;
  }

  /** Human-readable summary printed by `codali ask --trace`. */
  render(): string {
    const lines: string[] = [];
    lines.push(`run: ${this.record.runId ?? "(unassigned)"}`);
    lines.push(`status: ${this.record.status ?? "unknown"}`);
    if (this.record.completionReason) {
      lines.push(`completion: ${this.record.completionReason}`);
    }
    if (this.record.finalizerMode) {
      lines.push(`finalizer: ${this.record.finalizerMode}`);
    }
    lines.push(`duration: ${this.record.durationMs ?? 0}ms`);
    lines.push(`rounds: ${this.record.rounds}`);

    const bindings = Object.entries(this.record.roleBindings);
    if (bindings.length > 0) {
      lines.push("agents:");
      for (const [role, slug] of bindings) lines.push(`  ${role}: ${slug}`);
    }

    if (this.record.capabilities?.length) {
      lines.push(`capabilities: ${this.record.capabilities.join(", ")}`);
    }

    if (this.record.plannedTasks.length > 0) {
      lines.push("tasks:");
      for (const task of this.record.plannedTasks) {
        lines.push(`  ${task.id} [${task.role}] tools=${task.tools.join(",") || "none"}`);
        lines.push(`    ${task.objective}`);
      }
    }

    if (this.record.toolCalls.length > 0) {
      lines.push("tool calls:");
      for (const call of this.record.toolCalls) {
        const status = call.ok === undefined
          ? "pending"
          : call.ok
            ? "ok"
            : `failed(${call.errorCode ?? "unknown"})`;
        lines.push(
          `  ${call.tool} ${status} ${call.latencyMs ?? 0}ms ${JSON.stringify(call.args)}`,
        );
      }
    } else {
      lines.push("tool calls: none");
    }

    if (this.record.warnings.length > 0) {
      lines.push("warnings:");
      for (const warning of this.record.warnings) lines.push(`  ${warning}`);
    }

    return lines.join("\n");
  }
}
