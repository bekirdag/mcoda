import { Agent, AgentAuthMetadata, AgentHealth, AgentPromptManifest } from "@mcoda/shared";
import { GlobalRepository } from "@mcoda/db";
import { AgentAdapter, InvocationRequest, InvocationResult } from "../adapters/AdapterTypes.js";
interface AgentServiceOptions {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    checkInternetReachable?: () => Promise<boolean>;
    connectivityPollIntervalMs?: number;
}
export declare class AgentService {
    private repo;
    private options;
    constructor(repo: GlobalRepository, options?: AgentServiceOptions);
    static create(): Promise<AgentService>;
    close(): Promise<void>;
    resolveAgent(identifier: string): Promise<Agent>;
    getPrompts(agentId: string): Promise<AgentPromptManifest | undefined>;
    getCapabilities(agentId: string): Promise<string[]>;
    getAuthMetadata(agentId: string): Promise<AgentAuthMetadata>;
    private getDecryptedSecret;
    private buildAdapterConfig;
    private resolveAdapterType;
    getAdapter(agent: Agent, adapterOverride?: string): Promise<AgentAdapter>;
    private nowMs;
    private sleepMs;
    private sleepUntil;
    private getConnectivityPollIntervalMs;
    private isInternetReachable;
    private waitForInternetRecovery;
    private isOfflineCapable;
    private metric;
    private estimateWindowResetMs;
    private estimateResetMsFromWindowTypes;
    private normalizeLimitKey;
    private getAgentAvailability;
    private listEquivalentAgents;
    private findNextAvailableAgent;
    private findEarliestResetMs;
    private persistUsageLimitObservation;
    healthCheck(agentId: string): Promise<AgentHealth>;
    invoke(agentId: string, request: InvocationRequest): Promise<InvocationResult>;
    invokeStream(agentId: string, request: InvocationRequest): Promise<AsyncGenerator<InvocationResult>>;
    private applyGatewayHandoff;
    private recordInvocationFailure;
    private applyDocdexGuidance;
}
export {};
//# sourceMappingURL=AgentService.d.ts.map