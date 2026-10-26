import path from "node:path";
import { loadOrchestrationConfig } from "./OrchestrationConfig.js";

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
export async function loadNodeOrchestrationConfig(file: string, approved: ApprovedNodeModel) {
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
  return resolved;
}
