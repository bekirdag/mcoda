import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
type CodaliProviderResolution = {
    provider: string;
    sourceAdapter?: string;
    requiresApiKey: boolean;
    localOpenAiCompatible: boolean;
};
export declare const resolveCodaliProviderFromAdapter: (params: {
    sourceAdapter?: string;
    explicitProvider?: string;
}) => CodaliProviderResolution;
export declare class CodaliAdapter implements AgentAdapter {
    private config;
    constructor(config: AdapterConfig);
    getCapabilities(): Promise<string[]>;
    healthCheck(): Promise<AgentHealth>;
    invoke(request: InvocationRequest): Promise<InvocationResult>;
    invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown>;
}
export {};
//# sourceMappingURL=CodaliAdapter.d.ts.map