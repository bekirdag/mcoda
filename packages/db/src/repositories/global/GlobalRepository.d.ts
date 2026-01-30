import { Database } from "sqlite";
import { Agent, AgentAuthMetadata, AgentAuthSecret, AgentHealth, AgentModel, AgentPromptManifest, CreateAgentInput, UpdateAgentInput, WorkspaceDefault } from "@mcoda/shared";
import { Connection } from "../../sqlite/connection.js";
export type GlobalCommandStatus = "running" | "succeeded" | "failed";
export interface GlobalCommandRunInsert {
    commandName: string;
    startedAt: string;
    status: GlobalCommandStatus;
    exitCode?: number | null;
    errorSummary?: string | null;
    payload?: Record<string, unknown>;
}
export interface GlobalCommandRun extends GlobalCommandRunInsert {
    id: string;
    completedAt?: string | null;
    result?: Record<string, unknown>;
}
export interface GlobalTokenUsageInsert {
    agentId?: string | null;
    commandRunId?: string | null;
    modelName?: string | null;
    commandName?: string | null;
    action?: string | null;
    invocationKind?: string | null;
    provider?: string | null;
    currency?: string | null;
    tokensPrompt?: number | null;
    tokensCompletion?: number | null;
    tokensTotal?: number | null;
    tokensCached?: number | null;
    tokensCacheRead?: number | null;
    tokensCacheWrite?: number | null;
    costEstimate?: number | null;
    durationSeconds?: number | null;
    durationMs?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    timestamp: string;
    metadata?: Record<string, unknown>;
}
export interface AgentRunRatingInsert {
    agentId: string;
    jobId?: string | null;
    commandRunId?: string | null;
    taskId?: string | null;
    taskKey?: string | null;
    commandName?: string | null;
    discipline?: string | null;
    complexity?: number | null;
    qualityScore?: number | null;
    tokensTotal?: number | null;
    durationSeconds?: number | null;
    iterations?: number | null;
    totalCost?: number | null;
    runScore?: number | null;
    ratingVersion?: string | null;
    rawReview?: Record<string, unknown> | null;
    createdAt: string;
}
export interface AgentRunRatingRow extends AgentRunRatingInsert {
    id: string;
}
export declare class GlobalRepository {
    private db;
    private connection?;
    constructor(db: Database, connection?: Connection | undefined);
    static create(): Promise<GlobalRepository>;
    close(): Promise<void>;
    listAgents(): Promise<Agent[]>;
    getAgentById(id: string): Promise<Agent | undefined>;
    getAgentBySlug(slug: string): Promise<Agent | undefined>;
    createAgent(input: CreateAgentInput): Promise<Agent>;
    updateAgent(id: string, patch: UpdateAgentInput): Promise<Agent | undefined>;
    deleteAgent(id: string): Promise<void>;
    setAgentCapabilities(agentId: string, capabilities: string[]): Promise<void>;
    getAgentCapabilities(agentId: string): Promise<string[]>;
    setAgentModels(agentId: string, models: AgentModel[]): Promise<void>;
    getAgentModels(agentId: string): Promise<AgentModel[]>;
    setAgentPrompts(agentId: string, prompts: AgentPromptManifest): Promise<void>;
    getAgentPrompts(agentId: string): Promise<AgentPromptManifest | undefined>;
    setAgentAuth(agentId: string, encryptedSecret: string, lastVerifiedAt?: string): Promise<void>;
    getAgentAuthMetadata(agentId: string): Promise<AgentAuthMetadata>;
    getAgentAuthSecret(agentId: string): Promise<AgentAuthSecret | undefined>;
    setAgentHealth(health: AgentHealth): Promise<void>;
    getAgentHealth(agentId: string): Promise<AgentHealth | undefined>;
    listAgentHealthSummary(): Promise<AgentHealth[]>;
    setWorkspaceDefault(workspaceId: string, commandName: string, agentId: string, options?: {
        qaProfile?: string;
        docdexScope?: string;
    }): Promise<void>;
    getWorkspaceDefaults(workspaceId: string): Promise<WorkspaceDefault[]>;
    removeWorkspaceDefault(workspaceId: string, commandName: string): Promise<void>;
    findWorkspaceReferences(agentId: string): Promise<WorkspaceDefault[]>;
    createCommandRun(record: GlobalCommandRunInsert): Promise<GlobalCommandRun>;
    completeCommandRun(id: string, update: {
        status: GlobalCommandStatus;
        completedAt: string;
        exitCode?: number | null;
        errorSummary?: string | null;
        result?: Record<string, unknown>;
    }): Promise<void>;
    recordTokenUsage(entry: GlobalTokenUsageInsert): Promise<void>;
    insertAgentRunRating(entry: AgentRunRatingInsert): Promise<AgentRunRatingRow>;
    listAgentRunRatings(agentId: string, limit?: number): Promise<AgentRunRatingRow[]>;
}
//# sourceMappingURL=GlobalRepository.d.ts.map