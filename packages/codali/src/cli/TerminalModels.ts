import { configuredEmbeddingSpace, loadOrchestrationConfig, orchestrationHash, resolveBinding, validateOrchestrationConfig, type ModelOperation, type ResolvedOrchestrationConfig } from "../config/OrchestrationConfig.js";
import { atomicWriteJson, withStateLock } from "../session/AtomicState.js";

export const terminalModelOperation = (binding: string): ModelOperation => {
  if (binding === "embedding") return "embeddings";
  if (binding === "image") return "images.generations";
  if (binding === "audio") return "audio.generations";
  if (binding === "video") return "videos.generations";
  return "chat.completions";
};

export const proposeTerminalModel = (resolved: ResolvedOrchestrationConfig, binding: string, modelId: string): ResolvedOrchestrationConfig => {
  const config = structuredClone(resolved.config);
  if (!Object.prototype.hasOwnProperty.call(config.bindings, binding)) throw new Error(`Unknown configured binding: ${binding}`);
  if (!Object.prototype.hasOwnProperty.call(config.models, modelId)) throw new Error(`Unknown configured model: ${modelId}`);
  const previousSpace = config.bindings.embedding && config.bindings.embedding.enabled !== false ? configuredEmbeddingSpace(config) : undefined;
  const old = config.bindings[binding];
  config.bindings[binding] = { enabled: true, candidates: [modelId],
    ...((binding === "embedding" ? previousSpace?.label ?? old.embeddingSpace : old.embeddingSpace) ? { embeddingSpace: binding === "embedding" ? previousSpace?.label ?? old.embeddingSpace : old.embeddingSpace } : {}) };
  validateOrchestrationConfig(config);
  resolveBinding(config, binding, terminalModelOperation(binding));
  if (previousSpace && configuredEmbeddingSpace(config).id !== previousSpace.id) throw new Error("Embedding space would change. Use a new configuration and a fresh session to rebuild a separate index; the current index cannot be reused.");
  return { config, source: resolved.source, hash: orchestrationHash(config) };
};

/** Preserve concurrent edits; the caller must validate live entitlement before saving. */
export const saveTerminalModel = async (previous: ResolvedOrchestrationConfig, next: ResolvedOrchestrationConfig, signal: AbortSignal): Promise<void> => {
  if (next.source !== previous.source) throw new Error("Model selection must retain the shared configuration source");
  validateOrchestrationConfig(next.config);
  if (next.hash !== orchestrationHash(next.config)) throw new Error("Model configuration hash mismatch");
  signal.throwIfAborted();
  await withStateLock(previous.source, async () => {
    const current = await loadOrchestrationConfig(previous.source);
    if (current.hash !== previous.hash) throw new Error("Configuration changed on disk; use /config reload and review the selection again");
    signal.throwIfAborted();
    await atomicWriteJson(previous.source, next.config);
  });
};
