import { ParsedUsageLimitError } from "./UsageLimitParser.js";
export type ParsedInvocationFailure = {
    kind: "usage_limit";
    usageLimit: ParsedUsageLimitError;
} | {
    kind: "connectivity_issue";
    message: string;
    rawText: string;
} | {
    kind: "technical_issue";
    message: string;
    rawText: string;
};
export declare const parseInvocationFailure: (error: unknown, nowMs?: number) => ParsedInvocationFailure | null;
//# sourceMappingURL=InvocationFailureParser.d.ts.map