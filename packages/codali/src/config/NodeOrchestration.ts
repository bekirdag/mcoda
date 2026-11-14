import path from "node:path";
import { loadOrchestrationConfig, orchestrationHash } from "./OrchestrationConfig.js";

export interface ApprovedNodeModel {
  model: string;
  baseUrl?: string;
  modelDigest?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelsPath?: string;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
}

/** The node may serve only the model already admitted by its registry/job boundary. */
export async function loadNodeOrchestrationConfig(file: string, approved: ApprovedNodeModel, nativeReasoning: { reasoning_effort?: string; reasoning_budget_tokens?: number } = {}) {
  if (Object.keys(nativeReasoning).some(key => !["reasoning_effort", "reasoning_budget_tokens"].includes(key))) throw new Error("Unsupported native reasoning field");
  if (nativeReasoning.reasoning_effort !== undefined && (typeof nativeReasoning.reasoning_effort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(nativeReasoning.reasoning_effort))) throw new Error("Invalid reasoning_effort");
  if (nativeReasoning.reasoning_budget_tokens !== undefined && (!Number.isSafeInteger(nativeReasoning.reasoning_budget_tokens) || nativeReasoning.reasoning_budget_tokens < 0 || nativeReasoning.reasoning_budget_tokens > 1_000_000)) throw new Error("Invalid reasoning_budget_tokens");
  if (!path.isAbsolute(file)) throw new Error("Node orchestration config path must be absolute");
  if (!approved.baseUrl) throw new Error("Configured node orchestration requires an approved local runner");
  const endpoint = new URL(approved.baseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("Configured node orchestration requires a loopback runner");
  const normalize = (value: string) => new URL(value).toString().replace(/\/$/, "");
  const expectedCatalog = approved.modelsPath
    ? new URL(approved.modelsPath, `${normalize(endpoint.toString())}/`).toString()
    : `${normalize(endpoint.toString())}/models`;
  const resolved = await loadOrchestrationConfig(file);
  for (const provider of Object.values(resolved.config.providers)) {
    if (provider.adapter !== "openai-compatible" || normalize(provider.baseUrl) !== normalize(endpoint.toString())) {
      throw new Error("Node orchestration provider must match the approved runner; public gateway recursion is forbidden");
    }
    if (normalize(provider.catalogUrl ?? `${normalize(provider.baseUrl)}/models`) !== normalize(expectedCatalog)
      || provider.usageUrl || provider.mediaJobsUrl) throw new Error("Node orchestration catalog/operations differ from the approved runner");
  }
  for (const model of Object.values(resolved.config.models)) {
    if (model.catalogId !== approved.model || model.operations.some(operation => operation !== "chat.completions")) {
      throw new Error("Node orchestration cannot change the admitted model or operation");
    }
    if (approved.modelDigest && model.revision !== approved.modelDigest) throw new Error("Node orchestration model revision differs from the approved artifact");
    if (model.supportsTools && !approved.supportsTools || model.supportsStreaming && !approved.supportsStreaming) throw new Error("Node orchestration exceeds approved model capabilities");
    if (approved.contextWindow && model.contextWindow > approved.contextWindow
      || approved.maxOutputTokens && model.maxOutputTokens > approved.maxOutputTokens) throw new Error("Node orchestration exceeds approved model limits");
  }
  const sourceHash = resolved.hash;
  if (Object.values(nativeReasoning).some(value => value !== undefined)) {
    for (const model of Object.values(resolved.config.models)) {
      // The caller can select native reasoning, but cannot change the admitted
      // model, endpoint, tools or shared execution budget. All nested roles use
      // the same pinned effective configuration for this invocation.
      model.reasoning = Object.fromEntries((["low", "medium", "high", "max"] as const).map(level =>
        [level, { ...model.reasoning?.[level], ...nativeReasoning }]));
    }
    resolved.hash = orchestrationHash(resolved.config);
  }
  return { ...resolved, sourceHash };
}
