import type { EvalTaskExecution } from "./EvalTaskExecutor.js";
import type { EvalTaskDefinition } from "./SuiteSchema.js";

export interface EvalTaskExecutorLike {
  executeTask(task: EvalTaskDefinition): Promise<EvalTaskExecution>;
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  failed: number;
  execution_errors: number;
}

export interface EvalRunResult {
  schema_version: 1;
  suite_id: string;
  suite_fingerprint: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  task_results: EvalTaskExecution[];
  summary: EvalRunSummary;
}

export class EvalRunner {
  private readonly suiteId: string;

  private readonly suiteFingerprint: string;

  private readonly tasks: EvalTaskDefinition[];

  private readonly executor: EvalTaskExecutorLike;

  constructor(params: {
    suite_id: string;
    suite_fingerprint: string;
    tasks: EvalTaskDefinition[];
    executor: EvalTaskExecutorLike;
  }) {
    this.suiteId = params.suite_id;
    this.suiteFingerprint = params.suite_fingerprint;
    this.tasks = params.tasks;
    this.executor = params.executor;
  }

  async run(): Promise<EvalRunResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const taskResults: EvalTaskExecution[] = [];
    for (const task of this.tasks) {
      // Keep task ordering deterministic by executing suites sequentially.
      // This also keeps report comparisons stable across repeated runs.
      // eslint-disable-next-line no-await-in-loop
      taskResults.push(await this.executor.executeTask(task));
    }
    const endedAtMs = Date.now();
    const executionErrors = taskResults.filter((result) => Boolean(result.execution_error)).length;
    const passed = taskResults.filter((result) => result.task_passed).length;
    const summary: EvalRunSummary = {
      total: taskResults.length,
      passed,
      failed: taskResults.length - passed,
      execution_errors: executionErrors,
    };
    return {
      schema_version: 1,
      suite_id: this.suiteId,
      suite_fingerprint: this.suiteFingerprint,
      started_at: startedAt,
      ended_at: new Date(endedAtMs).toISOString(),
      duration_ms: endedAtMs - startedAtMs,
      task_results: taskResults,
      summary,
    };
  }
}
