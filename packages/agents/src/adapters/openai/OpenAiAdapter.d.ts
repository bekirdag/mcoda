import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
export declare class OpenAiAdapter implements AgentAdapter {
    private config;
    constructor(config: AdapterConfig);
    getCapabilities(): Promise<string[]>;
    healthCheck(): Promise<AgentHealth>;
    invoke(request: InvocationRequest): Promise<InvocationResult>;
    invokeStream(request: InvocationRequest): AsyncGenerator<InvocationResult, void, unknown>;
}
//# sourceMappingURL=OpenAiAdapter.d.ts.map