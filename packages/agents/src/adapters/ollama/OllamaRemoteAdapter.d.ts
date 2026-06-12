import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
export declare class OllamaRemoteAdapter implements AgentAdapter {
    private config;
    private baseUrl;
    private headers;
    private verifyTls;
    private tlsAgent;
    constructor(config: AdapterConfig & {
        baseUrl?: string;
        headers?: Record<string, string>;
        verifyTls?: boolean;
    });
    private assertConfig;
    getCapabilities(): Promise<string[]>;
    healthCheck(): Promise<AgentHealth>;
    private ensureBaseUrl;
    private ensureModel;
    private extractMetrics;
    invoke(request: InvocationRequest): Promise<InvocationResult>;
    invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown>;
}
//# sourceMappingURL=OllamaRemoteAdapter.d.ts.map