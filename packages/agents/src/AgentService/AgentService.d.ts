import { Agent, AgentAuthMetadata, AgentHealth, AgentPromptManifest } from "@mcoda/shared";
import { GlobalRepository } from "@mcoda/db";
import { AgentAdapter, InvocationRequest, InvocationResult } from "../adapters/AdapterTypes.js";
export declare class AgentService {
    private repo;
    constructor(repo: GlobalRepository);
    static create(): Promise<AgentService>;
    close(): Promise<void>;
    resolveAgent(identifier: string): Promise<Agent>;
    getPrompts(agentId: string): Promise<AgentPromptManifest | undefined>;
    getCapabilities(agentId: string): Promise<string[]>;
    getAuthMetadata(agentId: string): Promise<AgentAuthMetadata>;
    private getDecryptedSecret;
    private buildAdapterConfig;
    private resolveAdapterType;
    getAdapter(agent: Agent): Promise<AgentAdapter>;
    healthCheck(agentId: string): Promise<AgentHealth>;
    invoke(agentId: string, request: InvocationRequest): Promise<InvocationResult>;
    invokeStream(agentId: string, request: InvocationRequest): Promise<AsyncGenerator<InvocationResult>>;
}
//# sourceMappingURL=AgentService.d.ts.map