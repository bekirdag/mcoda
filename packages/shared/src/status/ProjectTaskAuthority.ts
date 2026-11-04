/** A terminal execution plan belongs to one existing project task, never a second backlog. */
export interface ProjectTaskSnapshot {
  schemaVersion: 1;
  authority: "mcoda";
  taskId: string;
  key: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  revision: string;
  dependencies: Array<{ taskId: string; status: string }>;
  lease?: { id: string; sessionId: string; expiresAt: string };
}

export interface ProjectTaskSubmission {
  operationId: string;
  sessionId: string;
  evidenceDigest: string;
  evidenceIds: string[];
  summary: string;
}

export interface ProjectTaskAttachment {
  snapshot: ProjectTaskSnapshot;
  pendingSubmission?: ProjectTaskSubmission;
  pendingInputHashes?: Record<string, string>;
  submittedOperationId?: string;
}

/** Implementations must compare revisions and leases inside an authoritative transaction. */
export interface ProjectTaskAuthority {
  read(taskIdOrKey: string): Promise<ProjectTaskSnapshot>;
  acquire(taskId: string, sessionId: string, expectedRevision: string): Promise<ProjectTaskSnapshot>;
  check(snapshot: ProjectTaskSnapshot): Promise<void>;
  renew(snapshot: ProjectTaskSnapshot): Promise<ProjectTaskSnapshot>;
  release(snapshot: ProjectTaskSnapshot): Promise<void>;
  /** Idempotent handoff to project review; it must not bypass review/QA to mark completed. */
  submit(snapshot: ProjectTaskSnapshot, submission: ProjectTaskSubmission): Promise<ProjectTaskSnapshot>;
}
