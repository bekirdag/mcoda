import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateEmbeddingRequest, validateEmbeddingResponse } from "@mcoda/shared";
import { configuredEmbeddingSpace, type ResolvedOrchestrationConfig } from "../config/OrchestrationConfig.js";
import { atomicWriteJson, withStateLock } from "../session/AtomicState.js";
import { ConfiguredProvider } from "./ConfiguredProvider.js";

export interface EmbeddingReceipt {
  id: string; modelId: string; catalogId: string; spaceId: string; configHash: string;
  purpose: "query" | "document"; inputs: number; reportedTokens?: number; elapsedMs: number;
  status: "succeeded" | "failed";
  failureCode?: "aborted" | "request_failed" | "upstream_error" | "invalid_response";
}
export interface EmbeddingIntent { id: string; modelId: string; catalogId: string; spaceId: string; inputs: number; estimatedTokens: number; }

/** Owns embedding identity; network retries after dispatch are deliberately left to the caller. */
export class ConfiguredEmbeddings {
  readonly space;
  private readonly router: ConfiguredProvider;
  constructor(readonly resolved: ResolvedOrchestrationConfig, private readonly onReceipt?: (receipt: EmbeddingReceipt) => Promise<void>,
    private readonly beforeRequest?: (intent: EmbeddingIntent) => Promise<void>) {
    this.space = configuredEmbeddingSpace(resolved.config);
    this.router = new ConfiguredProvider(resolved, "embedding");
  }

  async pin(directory: string): Promise<void> {
    const file = path.join(directory, "embedding-space.json");
    await withStateLock(file, async () => {
      try {
        const previous = JSON.parse(await fs.readFile(file, "utf8"));
        if (previous.schemaVersion !== 1 || previous.space?.id !== this.space.id) throw new Error("Embedding space changed; rebuild into a separate index before using this configuration");
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await atomicWriteJson(file, { schemaVersion: 1, space: this.space, createdAt: new Date().toISOString() });
    });
  }

  async embed(input: string[], purpose: "query" | "document", signal?: AbortSignal): Promise<number[][]> {
    const prefix = purpose === "query" ? this.space.queryPrefix : this.space.documentPrefix;
    const prepared = validateEmbeddingRequest({ input: input.map(text => prefix + text) }, "pending");
    const selected = await this.router.select("embeddings", signal);
    const descriptor = Array.isArray(selected.actual.raw.operations)
      ? selected.actual.raw.operations.find(value => value && typeof value === "object" && (value as Record<string, unknown>).type === "embeddings") as { limits?: { embedding_dimensions?: number } } | undefined : undefined;
    if (selected.provider.adapter === "mswarm" && (!descriptor || descriptor.limits?.embedding_dimensions !== this.space.dimensions)) {
      throw new Error("Embedding catalog does not attest the configured dimensions");
    }
    if (selected.provider.adapter === "mswarm" && selected.actual.raw.digest !== this.space.revision) throw new Error("Embedding catalog revision does not match the pinned artifact");
    const started = Date.now();
    const id = randomUUID();
    await this.beforeRequest?.({ id, modelId: selected.id, catalogId: selected.model.catalogId, spaceId: this.space.id,
      inputs: input.length, estimatedTokens: Math.ceil(JSON.stringify(prepared.input).length / 3) });
    const receipt = { id, modelId: selected.id, catalogId: selected.model.catalogId,
      spaceId: this.space.id, configHash: this.resolved.hash, purpose, inputs: input.length };
    let failureCode: EmbeddingReceipt["failureCode"] = "request_failed";
    let vectors: number[][];
    let reportedTokens: number | undefined;
    try {
      const payload = await this.router.client(selected.model.provider).json(`${selected.provider.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST", body: { ...prepared, model: selected.model.catalogId }, signal, timeoutMs: 120_000,
      });
      // A relay may start a 200 keepalive before native execution fails.
      // Do not expose upstream messages, which can contain private input.
      if (payload && typeof payload === "object" && "error" in payload) {
        failureCode = "upstream_error";
        throw new Error("Embedding upstream execution failed");
      }
      failureCode = "invalid_response";
      const result = validateEmbeddingResponse(payload, input.length, this.space.dimensions, selected.model.catalogId);
      if (selected.provider.adapter === "mswarm" && (payload as Record<string, unknown>).embedding_revision !== this.space.revision) throw new Error("Embedding response revision changed after selection");
      vectors = result.data.map(item => {
        if (this.space.normalization === "none") return item.embedding;
        const scale = Math.max(...item.embedding.map(Math.abs));
        if (!scale) throw new Error("Embedding model returned a zero vector");
        const norm = Math.sqrt(item.embedding.reduce((sum, value) => sum + (value / scale) ** 2, 0));
        return item.embedding.map(value => value / scale / norm);
      });
      reportedTokens = result.usage?.total_tokens;
    } catch (error) {
      await this.onReceipt?.({ ...receipt, status: "failed", failureCode: signal?.aborted ? "aborted" : failureCode,
        elapsedMs: Date.now() - started });
      throw error;
    }
    await this.onReceipt?.({ ...receipt, status: "succeeded",
      ...(reportedTokens !== undefined ? { reportedTokens } : {}), elapsedMs: Date.now() - started });
    return vectors;
  }
}
