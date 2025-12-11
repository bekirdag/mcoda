export type AgentHealthStatus = "healthy" | "degraded" | "unreachable";
export interface Agent {
    id: string;
    slug: string;
    adapter: string;
    defaultModel?: string;
    config?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}
export interface CreateAgentInput {
    slug: string;
    adapter: string;
    defaultModel?: string;
    config?: Record<string, unknown>;
    capabilities?: string[];
    prompts?: AgentPromptManifest;
}
export interface UpdateAgentInput {
    adapter?: string;
    defaultModel?: string;
    config?: Record<string, unknown>;
    capabilities?: string[];
    prompts?: AgentPromptManifest;
}
export interface AgentCapability {
    agentId: string;
    capability: string;
}
export interface AgentPromptManifest {
    agentId?: string;
    jobPrompt?: string;
    characterPrompt?: string;
    commandPrompts?: Record<string, string>;
    jobPath?: string;
    characterPath?: string;
}
export interface AgentAuthMetadata {
    agentId: string;
    configured: boolean;
    lastUpdatedAt?: string;
    lastVerifiedAt?: string;
}
export interface AgentAuthSecret extends AgentAuthMetadata {
    encryptedSecret: string;
}
export type UpdateChannel = "stable" | "beta" | "nightly";
export interface UpdateInfo {
    currentVersion: string;
    latestVersion: string;
    channel: UpdateChannel;
    updateAvailable: boolean;
    notes?: string | null;
}
export interface ApplyUpdateResponse {
    status: "started" | "already_up_to_date" | "completed";
    logFile?: string | null;
}
export interface AgentHealth {
    agentId: string;
    status: AgentHealthStatus;
    lastCheckedAt: string;
    latencyMs?: number;
    details?: Record<string, unknown>;
}
export interface WorkspaceDefault {
    workspaceId: string;
    commandName: string;
    agentId: string;
    updatedAt: string;
}
export type VelocitySource = "config" | "empirical" | "mixed";
export interface BacklogLaneTotals {
    tasks: number;
    story_points: number;
}
export interface BacklogTotals {
    implementation: BacklogLaneTotals;
    review: BacklogLaneTotals;
    qa: BacklogLaneTotals;
    done: BacklogLaneTotals;
}
export interface BacklogSummary {
    scope: {
        project?: string;
        epic?: string;
        story?: string;
        assignee?: string;
    };
    totals: BacklogTotals;
}
export interface EffectiveVelocity {
    implementationSpPerHour: number;
    reviewSpPerHour: number;
    qaSpPerHour: number;
    source: VelocitySource;
    windowTasks?: 10 | 20 | 50;
    samples?: {
        implementation?: number;
        review?: number;
        qa?: number;
    };
}
export interface EstimateDurations {
    implementationHours: number | null;
    reviewHours: number | null;
    qaHours: number | null;
    totalHours: number | null;
}
export interface EstimateEtas {
    readyToReviewEta?: string;
    readyToQaEta?: string;
    completeEta?: string;
}
export interface EstimateResult {
    scope: {
        project?: string;
        epic?: string;
        story?: string;
        assignee?: string;
        workspaceId: string;
    };
    backlogTotals: BacklogTotals;
    effectiveVelocity: EffectiveVelocity;
    durationsHours: EstimateDurations;
    etas: EstimateEtas;
}
export type RefineStrategy = "split" | "merge" | "enrich" | "estimate" | "auto";
export interface RefineTasksRequest {
    projectKey: string;
    epicKey?: string;
    userStoryKey?: string;
    taskKeys?: string[];
    statusFilter?: string[];
    strategy?: RefineStrategy;
    maxTasks?: number;
    dryRun?: boolean;
    agentIdOverride?: string;
    planInPath?: string;
    planOutPath?: string;
}
export interface UpdateTaskOp {
    op: "update_task";
    taskKey: string;
    updates: {
        title?: string;
        description?: string;
        acceptanceCriteria?: string[];
        type?: string;
        storyPoints?: number | null;
        priority?: number | null;
        metadata?: Record<string, unknown>;
        status?: string;
    };
}
export interface SplitChildTask {
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
    type?: string;
    storyPoints?: number | null;
    priority?: number | null;
    metadata?: Record<string, unknown>;
    dependsOn?: string[];
}
export interface SplitTaskOp {
    op: "split_task";
    taskKey: string;
    keepParent?: boolean;
    parentUpdates?: UpdateTaskOp["updates"];
    children: SplitChildTask[];
}
export interface MergeTasksOp {
    op: "merge_tasks";
    targetTaskKey: string;
    sourceTaskKeys: string[];
    updates?: UpdateTaskOp["updates"];
    cancelSources?: boolean;
}
export interface UpdateEstimateOp {
    op: "update_estimate";
    taskKey: string;
    storyPoints?: number | null;
    type?: string;
    priority?: number | null;
}
export type RefineOperation = UpdateTaskOp | SplitTaskOp | MergeTasksOp | UpdateEstimateOp;
export interface RefineTasksPlan {
    strategy?: RefineStrategy;
    operations: RefineOperation[];
    warnings?: string[];
    metadata?: {
        generatedAt: string;
        projectKey: string;
        epicKeys?: string[];
        storyKeys?: string[];
        jobId?: string;
        commandRunId?: string;
        strategy?: RefineStrategy;
    };
}
export interface RefineTasksResult {
    jobId: string;
    commandRunId: string;
    plan: RefineTasksPlan;
    applied: boolean;
    createdTasks?: string[];
    updatedTasks?: string[];
    cancelledTasks?: string[];
    summary?: {
        tasksProcessed: number;
        tasksAffected: number;
        storyPointsDelta?: number;
    };
}
//# sourceMappingURL=OpenApiTypes.d.ts.map
