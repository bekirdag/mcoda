import { verifiedTokenUsage } from "../providers/ConfiguredModelScope.js";
import type { ProviderUsage } from "../providers/ProviderTypes.js";

export interface UsageEvent { type: string; data: Record<string, unknown>; }
export interface UsageAccount {
  id: string; kind: "model" | "embedding"; configHash?: string; clientRequestId?: string;
  modelId?: string; counted: boolean; reserve?: number; usage?: ProviderUsage;
  reconciled?: boolean;
}
const valid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Rebuild by invocation identity so replayed settlements never add a second charge. */
export function usageAccounts(events: UsageEvent[]): Map<string, UsageAccount> {
  const accounts = new Map<string, UsageAccount>();
  for (const { type, data } of events) {
    const id = typeof data.id === "string" ? data.id : undefined;
    if ((type === "model_intent" || type === "embedding_intent") && id) {
      const reserve = type === "model_intent" ? data.reservedTokens : data.estimatedTokens;
      accounts.set(id, { id, kind: type === "model_intent" ? "model" : "embedding", counted: true,
        configHash: typeof data.configHash === "string" ? data.configHash : undefined,
        clientRequestId: typeof data.clientRequestId === "string" ? data.clientRequestId : undefined,
        reserve: valid(reserve) ? reserve : undefined });
    } else if (type === "model_usage_reconciled" && Array.isArray(data.receipts)) {
      for (const raw of data.receipts) {
        const receipt = raw as { id?: string; clientRequestId?: string; usage?: ProviderUsage };
        const account = receipt.id ? accounts.get(receipt.id) : undefined;
        if (account && account.clientRequestId && account.clientRequestId === receipt.clientRequestId && verifiedTokenUsage(receipt.usage)) {
          account.usage = receipt.usage; account.reconciled = true;
        }
      }
    } else if (id) {
      const account = accounts.get(id); if (!account) continue;
      if (type === "model_route" && data.configHash === account.configHash && typeof data.modelId === "string") account.modelId = data.modelId;
      if (type === "model_receipt") {
        if (data.status === "not_dispatched") account.counted = false;
        const usage = data.usage as (ProviderUsage & { estimated?: boolean }) | undefined;
        if (usage?.estimated === false && verifiedTokenUsage(usage)) account.usage = usage;
        else if (valid(usage?.totalTokens)) account.reserve = usage.totalTokens;
        else if (valid(data.reservedTokens)) account.reserve = data.reservedTokens;
      }
      if (type === "embedding_receipt" && valid(data.reportedTokens)) account.usage = { inputTokens: data.reportedTokens, outputTokens: 0, totalTokens: data.reportedTokens };
    }
  }
  return accounts;
}

export function accountedUsage(accounts: Iterable<UsageAccount>): {
  modelCalls: number; tokens: number; inputTokens: number; outputTokens: number;
  embeddingCalls: number; embeddingTokens: number; estimated: boolean;
} | undefined {
  const total = { modelCalls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, embeddingCalls: 0, embeddingTokens: 0, estimated: false };
  for (const account of accounts) {
    if (!account.counted) continue;
    const reported = verifiedTokenUsage(account.usage); const tokens = reported?.total ?? account.reserve;
    if (tokens === undefined) return undefined;
    total.modelCalls++; total.tokens += tokens; total.inputTokens += reported?.input ?? 0; total.outputTokens += reported?.output ?? 0;
    total.estimated ||= !reported;
    if (account.kind === "embedding") { total.embeddingCalls++; total.embeddingTokens += reported?.total ?? 0; }
  }
  return Object.entries(total).every(([key, value]) => key === "estimated" || valid(value)) ? total : undefined;
}
