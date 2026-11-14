import { createHash, randomUUID } from "node:crypto";
import { WorkspaceRepository, type TaskRow } from "@mcoda/db";
import type { ProjectTaskAuthority, ProjectTaskSnapshot, ProjectTaskSubmission } from "@mcoda/shared";
import { TaskStateService } from "./TaskStateService.js";

const METADATA_KEY = "codali_execution";
interface ExecutionMetadata {
  lease?: NonNullable<ProjectTaskSnapshot["lease"]>;
  submission?: ProjectTaskSubmission & { revision: string; acceptedRevision?: string };
}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

/** mcoda's database and TaskStateService own project status; Codali supplies execution evidence. */
export class McodaProjectTaskAuthority implements ProjectTaskAuthority {
  private readonly state: TaskStateService;
  constructor(private readonly repo: WorkspaceRepository, private readonly options: { now?: () => number; leaseMs?: number } = {}) {
    this.state = new TaskStateService(repo);
    if (options.leaseMs !== undefined && (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1000 || options.leaseMs > 300000)) throw new Error("Invalid project lease duration");
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private execution(task: TaskRow): ExecutionMetadata { return (task.metadata?.[METADATA_KEY] ?? {}) as ExecutionMetadata; }
  private async task(key: string): Promise<TaskRow> {
    const task = await this.repo.getTaskById(key) ?? await this.repo.getTaskByKey(key);
    if (!task) throw new Error(`Project task does not exist: ${key}`);
    return task;
  }
  private async snapshot(task: TaskRow): Promise<ProjectTaskSnapshot> {
    const rows = await this.repo.getDb().all<Array<{ task_id: string; status: string; relation_type: string }>>(
      "SELECT d.depends_on_task_id AS task_id, COALESCE(t.status, 'missing') AS status, d.relation_type FROM task_dependencies d LEFT JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ? ORDER BY d.depends_on_task_id, d.relation_type", task.id);
    const metadata = { ...task.metadata }; delete metadata[METADATA_KEY];
    const contract = { taskId: task.id, key: task.key, projectId: task.projectId, title: task.title, description: task.description ?? "", status: task.status, metadata, dependencies: rows };
    return { schemaVersion: 1, authority: "mcoda", taskId: task.id, key: task.key, projectId: task.projectId, title: task.title,
      description: task.description ?? "", status: task.status, revision: digest(contract),
      dependencies: rows.map(row => ({ taskId: row.task_id, status: row.status })), lease: this.execution(task).lease };
  }
  private async save(task: TaskRow, value: ExecutionMetadata): Promise<void> {
    await this.repo.updateTask(task.id, { metadata: { ...task.metadata, [METADATA_KEY]: value } });
  }
  private assertCurrent(current: ProjectTaskSnapshot, expected: ProjectTaskSnapshot): void {
    if (current.revision !== expected.revision) throw new Error("Project task changed; refresh its contract before continuing");
    if (!expected.lease || !current.lease || current.lease.id !== expected.lease.id || current.lease.sessionId !== expected.lease.sessionId || !Number.isFinite(Date.parse(current.lease.expiresAt)) || Date.parse(current.lease.expiresAt) <= this.now()) throw new Error("Project task lease expired or was replaced");
    if (current.status !== "in_progress") throw new Error("Project task is no longer in progress");
    if (current.dependencies.some(item => !["completed", "cancelled"].includes(item.status))) throw new Error("Project task dependencies are not complete");
  }
  read(key: string): Promise<ProjectTaskSnapshot> { return this.repo.withTransaction(async () => this.snapshot(await this.task(key))); }
  acquire(taskId: string, sessionId: string, expectedRevision: string): Promise<ProjectTaskSnapshot> {
    return this.repo.withTransaction(async () => {
      const task = await this.task(taskId); const current = await this.snapshot(task); const execution = this.execution(task);
      if (current.revision !== expectedRevision) throw new Error("Project task changed; refresh its contract before continuing");
      if (current.dependencies.some(item => !["completed", "cancelled"].includes(item.status))) throw new Error("Project task dependencies are not complete");
      if (current.lease && (!Number.isFinite(Date.parse(current.lease.expiresAt)) || Date.parse(current.lease.expiresAt) > this.now())) throw new Error("Project task already has an active or invalid execution lease");
      if (!["not_started", "changes_requested", "failed"].includes(task.status) && !(task.status === "in_progress" && current.lease)) throw new Error(`Project task cannot be claimed from ${task.status}`);
      const lease = { id: randomUUID(), sessionId, expiresAt: new Date(this.now() + (this.options.leaseMs ?? 120000)).toISOString() };
      await this.state.transitionToInProgress(task, { commandName: "codali", metadata: { sessionId, leaseId: lease.id } });
      await this.save(task, { ...execution, lease });
      return this.snapshot(await this.task(task.id));
    });
  }
  check(expected: ProjectTaskSnapshot): Promise<void> { return this.repo.withTransaction(async () => { this.assertCurrent(await this.snapshot(await this.task(expected.taskId)), expected); }); }
  renew(expected: ProjectTaskSnapshot): Promise<ProjectTaskSnapshot> {
    return this.repo.withTransaction(async () => {
      const task = await this.task(expected.taskId); const current = await this.snapshot(task); this.assertCurrent(current, expected);
      await this.save(task, { ...this.execution(task), lease: { ...current.lease!, expiresAt: new Date(this.now() + (this.options.leaseMs ?? 120000)).toISOString() } });
      return this.snapshot(await this.task(task.id));
    });
  }
  release(expected: ProjectTaskSnapshot): Promise<void> {
    return this.repo.withTransaction(async () => {
      const task = await this.task(expected.taskId); const execution = this.execution(task);
      if (!expected.lease || execution.lease?.id !== expected.lease.id) return;
      await this.save(task, { ...execution, lease: { ...execution.lease, expiresAt: new Date(this.now()).toISOString() } });
    });
  }
  submit(expected: ProjectTaskSnapshot, submission: ProjectTaskSubmission): Promise<ProjectTaskSnapshot> {
    return this.repo.withTransaction(async () => {
      if (!submission.operationId || submission.sessionId !== expected.lease?.sessionId || !/^[a-f0-9]{64}$/.test(submission.evidenceDigest) || !submission.evidenceIds.length || !submission.summary.trim()) throw new Error("Invalid project verification submission");
      const task = await this.task(expected.taskId); const execution = this.execution(task);
      if (execution.submission?.operationId === submission.operationId) {
        const { revision, acceptedRevision, ...prior } = execution.submission;
        if (digest(prior) !== digest(submission) || revision !== expected.revision) throw new Error("Conflicting project submission replay");
        const current = await this.snapshot(task);
        if (current.revision !== acceptedRevision) throw new Error("Project task changed after submission; inspect its current review state");
        return current;
      }
      this.assertCurrent(await this.snapshot(task), expected);
      await this.state.markReadyToReview(task, { [METADATA_KEY]: { lease: { ...execution.lease!, expiresAt: new Date(this.now()).toISOString() }, submission: { ...submission, revision: expected.revision } } },
        { commandName: "codali", metadata: { sessionId: submission.sessionId, operationId: submission.operationId, evidenceDigest: submission.evidenceDigest } });
      const accepted = await this.snapshot(await this.task(task.id));
      await this.save(task, { ...this.execution(task), submission: { ...submission, revision: expected.revision, acceptedRevision: accepted.revision } });
      return accepted;
    });
  }
}
