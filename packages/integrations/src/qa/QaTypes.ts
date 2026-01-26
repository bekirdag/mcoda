import type { QaBrowserAction } from '@mcoda/shared/qa/QaPlan.js';

export type QaOutcome = 'pass' | 'fail' | 'infra_issue';

export interface QaRunResult {
  outcome: QaOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  artifacts: string[];
  startedAt: string;
  finishedAt: string;
}

export interface QaEnsureResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface QaContext {
  workspaceRoot: string;
  jobId: string;
  taskKey: string;
  env: NodeJS.ProcessEnv;
  testCommandOverride?: string;
  commands?: string[];
  browserActions?: QaBrowserAction[];
  browserBaseUrl?: string;
  artifactDir?: string;
}
