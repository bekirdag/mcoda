import { AgentHealth } from "@mcoda/shared";
import { AdapterConfig, AgentAdapter, InvocationRequest, InvocationResult } from "../AdapterTypes.js";
export declare class MswarmWorkerAdapter implements AgentAdapter {
    private readonly config;
    private readonly worker;
    private readonly runUrl;
    constructor(config: AdapterConfig);
    getCapabilities(): Promise<string[]>;
    healthCheck(): Promise<AgentHealth>;
    invoke(request: InvocationRequest): Promise<InvocationResult>;
}
//# sourceMappingURL=MswarmWorkerAdapter.d.ts.map