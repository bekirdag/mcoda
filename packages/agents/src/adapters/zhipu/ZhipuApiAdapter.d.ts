import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
type ZhipuConfig = AdapterConfig & {
    baseUrl?: string;
    headers?: Record<string, string>;
    temperature?: number;
    thinking?: boolean | Record<string, unknown>;
    extraBody?: Record<string, unknown>;
};
export declare class ZhipuApiAdapter implements AgentAdapter {
    private config;
    private baseUrl;
    private headers;
    private temperature;
    private thinking;
    private extraBody;
    constructor(config: ZhipuConfig);
    getCapabilities(): Promise<string[]>;
    healthCheck(): Promise<AgentHealth>;
    invoke(request: InvocationRequest): Promise<InvocationResult>;
    invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown>;
    private assertConfig;
    private ensureBaseUrl;
    private ensureModel;
    private ensureApiKey;
    private buildHeaders;
    private buildBody;
}
export {};
//# sourceMappingURL=ZhipuApiAdapter.d.ts.map