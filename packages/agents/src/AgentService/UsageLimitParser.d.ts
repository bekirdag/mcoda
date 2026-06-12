import { AgentUsageLimitWindowType } from "@mcoda/shared";
export type UsageLimitResetSource = "header" | "relative" | "absolute";
export interface ParsedUsageLimitError {
    isUsageLimit: true;
    message: string;
    rawText: string;
    windowTypes: AgentUsageLimitWindowType[];
    resetAt?: string;
    resetAtSource?: UsageLimitResetSource;
}
export declare const extractUsageLimitErrorText: (error: unknown) => string;
export declare const parseUsageLimitError: (error: unknown, nowMs?: number) => ParsedUsageLimitError | null;
//# sourceMappingURL=UsageLimitParser.d.ts.map