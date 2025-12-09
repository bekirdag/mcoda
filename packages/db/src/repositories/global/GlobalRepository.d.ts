import { Database } from "sqlite";
import { Agent, AgentAuthMetadata, AgentAuthSecret, AgentHealth, AgentPromptManifest, CreateAgentInput, UpdateAgentInput, WorkspaceDefault } from "@mcoda/shared";
import { Connection } from "../../sqlite/connection.js";
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
    setAgentPrompts(agentId: string, prompts: AgentPromptManifest): Promise<void>;
    getAgentPrompts(agentId: string): Promise<AgentPromptManifest | undefined>;
    setAgentAuth(agentId: string, encryptedSecret: string, lastVerifiedAt?: string): Promise<void>;
    getAgentAuthMetadata(agentId: string): Promise<AgentAuthMetadata>;
    getAgentAuthSecret(agentId: string): Promise<AgentAuthSecret | undefined>;
    setAgentHealth(health: AgentHealth): Promise<void>;
    getAgentHealth(agentId: string): Promise<AgentHealth | undefined>;
    listAgentHealthSummary(): Promise<AgentHealth[]>;
    setWorkspaceDefault(workspaceId: string, commandName: string, agentId: string): Promise<void>;
    getWorkspaceDefaults(workspaceId: string): Promise<WorkspaceDefault[]>;
    findWorkspaceReferences(agentId: string): Promise<WorkspaceDefault[]>;
}
//# sourceMappingURL=GlobalRepository.d.ts.map