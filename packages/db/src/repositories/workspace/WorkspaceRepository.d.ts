import { Database } from "sqlite";
import { Connection } from "../../sqlite/connection.js";
export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type CommandStatus = "running" | "succeeded" | "failed";
export type TaskRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface ProjectRow {
    id: string;
    key: string;
    name?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}
export interface EpicInsert {
    projectId: string;
    key: string;
    title: string;
    description: string;
    storyPointsTotal?: number | null;
    priority?: number | null;
    metadata?: Record<string, unknown>;
}
export interface EpicRow extends EpicInsert {
    id: string;
    createdAt: string;
    updatedAt: string;
}
export interface StoryInsert {
    projectId: string;
    epicId: string;
    key: string;
    title: string;
    description: string;
    acceptanceCriteria?: string | null;
    storyPointsTotal?: number | null;
    priority?: number | null;
    metadata?: Record<string, unknown>;
}
export interface StoryRow extends StoryInsert {
    id: string;
    createdAt: string;
    updatedAt: string;
}
export interface TaskInsert {
    projectId: string;
    epicId: string;
    userStoryId: string;
    key: string;
    title: string;
    description: string;
    type?: string | null;
    status: string;
    storyPoints?: number | null;
    priority?: number | null;
    assignedAgentId?: string | null;
    assigneeHuman?: string | null;
    vcsBranch?: string | null;
    vcsBaseBranch?: string | null;
    vcsLastCommitSha?: string | null;
    metadata?: Record<string, unknown>;
    openapiVersionAtCreation?: string | null;
}
export interface TaskRow extends TaskInsert {
    id: string;
    createdAt: string;
    updatedAt: string;
}
export interface TaskDependencyInsert {
    taskId: string;
    dependsOnTaskId: string;
    relationType: string;
}
export interface TaskDependencyRow extends TaskDependencyInsert {
    id: string;
    createdAt: string;
    updatedAt: string;
}
export interface JobInsert {
    workspaceId: string;
    type: string;
    state: JobStatus;
    commandName?: string;
    payload?: Record<string, unknown>;
    totalItems?: number | null;
    processedItems?: number | null;
    lastCheckpoint?: string | null;
}
export interface JobRow extends JobInsert {
    id: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string | null;
    errorSummary?: string | null;
}
export interface CommandRunInsert {
    workspaceId: string;
    commandName: string;
    jobId?: string | null;
    taskIds?: string[];
    gitBranch?: string | null;
    gitBaseBranch?: string | null;
    startedAt: string;
    status: CommandStatus;
}
export interface CommandRunRow extends CommandRunInsert {
    id: string;
    completedAt?: string | null;
    errorSummary?: string | null;
    durationSeconds?: number | null;
}
export interface TaskRunInsert {
    taskId: string;
    command: string;
    status: TaskRunStatus;
    jobId?: string | null;
    commandRunId?: string | null;
    agentId?: string | null;
    startedAt: string;
    finishedAt?: string | null;
    storyPointsAtRun?: number | null;
    spPerHourEffective?: number | null;
    gitBranch?: string | null;
    gitBaseBranch?: string | null;
    gitCommitSha?: string | null;
    runContext?: Record<string, unknown>;
}
export interface TaskRunRow extends TaskRunInsert {
    id: string;
}
export interface TokenUsageInsert {
    workspaceId: string;
    agentId?: string | null;
    modelName?: string | null;
    jobId?: string | null;
    commandRunId?: string | null;
    taskRunId?: string | null;
    taskId?: string | null;
    projectId?: string | null;
    epicId?: string | null;
    userStoryId?: string | null;
    tokensPrompt?: number | null;
    tokensCompletion?: number | null;
    tokensTotal?: number | null;
    costEstimate?: number | null;
    durationSeconds?: number | null;
    timestamp: string;
    metadata?: Record<string, unknown>;
}
export declare class WorkspaceRepository {
    private db;
    private connection?;
    constructor(db: Database, connection?: Connection | undefined);
    static create(cwd?: string): Promise<WorkspaceRepository>;
    close(): Promise<void>;
    withTransaction<T>(fn: () => Promise<T>): Promise<T>;
    getProjectByKey(key: string): Promise<ProjectRow | undefined>;
    createProjectIfMissing(input: {
        key: string;
        name?: string;
        description?: string;
    }): Promise<ProjectRow>;
    insertEpics(epics: EpicInsert[], useTransaction?: boolean): Promise<EpicRow[]>;
    insertStories(stories: StoryInsert[], useTransaction?: boolean): Promise<StoryRow[]>;
    insertTasks(tasks: TaskInsert[], useTransaction?: boolean): Promise<TaskRow[]>;
    insertTaskDependencies(deps: TaskDependencyInsert[], useTransaction?: boolean): Promise<TaskDependencyRow[]>;
    listEpicKeys(projectId: string): Promise<string[]>;
    listStoryKeys(epicId: string): Promise<string[]>;
    listTaskKeys(userStoryId: string): Promise<string[]>;
    createJob(record: JobInsert): Promise<JobRow>;
    updateJobState(id: string, update: Partial<JobInsert> & {
        state?: JobStatus;
        errorSummary?: string | null;
        completedAt?: string | null;
    }): Promise<void>;
    createCommandRun(record: CommandRunInsert): Promise<CommandRunRow>;
    completeCommandRun(id: string, update: {
        status: CommandStatus;
        completedAt: string;
        errorSummary?: string | null;
        durationSeconds?: number | null;
    }): Promise<void>;
    createTaskRun(record: TaskRunInsert): Promise<TaskRunRow>;
    recordTokenUsage(entry: TokenUsageInsert): Promise<void>;
}
//# sourceMappingURL=WorkspaceRepository.d.ts.map