export type ModelServiceErrorCode = "authentication_failed" | "entitlement_missing" | "quota_exhausted" | "rate_limited" | "service_unavailable" | "model_unavailable" | "invalid_request" | "invalid_response" | "context_length_exceeded";

function nativeContextRefusal(error: Record<string, unknown>): boolean {
  if (error.type !== "invalid_request_error" || typeof error.message !== "string" || error.message.length > 1024) return false;
  // Strata currently emits this pre-generation refusal without a machine code.
  // Match only its bounded numeric diagnostics; never retain prompt text.
  return /^request exceeds the context window: prompt \(\d{1,10} tokens\) leaves no room to answer in the context \(\d{1,10}\); requests are never truncated$/.test(error.message)
    || /^request exceeds the context window: prompt \(\d{1,10} tokens\) \+ max tokens \(\d{1,10}\) exceeds the context \(\d{1,10}\); requests are never truncated\. Send a smaller max_tokens \(at most \d{1,10} here\), or add "fit_max_tokens": true to the model's strata-<model>\.json to shorten it to the room left \(#545\)$/.test(error.message);
}

/** Transport diagnostics contain stable classifications, never an upstream body. */
export class ModelServiceError extends Error {
  /** Set by Runner, not inferred from an HTTP status or upstream payload. */
  completedModelCalls?: number;
  constructor(readonly code: ModelServiceErrorCode, readonly status: number, readonly retryAfterSeconds?: number,
    readonly nativeContextRefused = false) {
    super(`Model service HTTP ${status}: ${code}${code === "authentication_failed" ? "; authenticate with codali login" : code === "context_length_exceeded" ? "; checkpoint and reduce context before continuing" : ""}`);
    this.name = "ModelServiceError";
  }

  /** A relay may already have sent HTTP 200 headers when the model fails. */
  static fromRelayError(error: unknown): ModelServiceError | undefined {
    if (!error || typeof error !== "object") return undefined;
    const code = (error as Record<string, unknown>).code;
    if (code === "context_length_exceeded" || code === "invalid_response" || code === "rate_limited") return new ModelServiceError(code, 200);
    return undefined;
  }

  static async fromResponse(response: Response): Promise<ModelServiceError> {
    let serverCode = "";
    let contextRefused = false;
    let nativeRefused = false;
    if (response.body) {
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 8192) break; chunks.push(part.value); }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: Record<string, unknown>; code?: unknown };
        if (typeof (payload.error?.code ?? payload.code) === "string") serverCode = String(payload.error?.code ?? payload.code);
        nativeRefused = response.status === 400 && !!payload.error && nativeContextRefusal(payload.error);
        contextRefused = response.status === 400 && (serverCode === "context_length_exceeded" || nativeRefused);
      } catch { /* The status still supplies a safe classification. */ }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
    const code: ModelServiceErrorCode = response.status === 401 ? "authentication_failed"
      : response.status === 403 ? "entitlement_missing"
      : ["quota_exceeded", "quota_exhausted", "insufficient_quota", "credits_exhausted", "insufficient_credits"].includes(serverCode) || response.status === 402 ? "quota_exhausted"
      : response.status === 429 ? "rate_limited"
      : response.status === 404 ? "model_unavailable"
      : contextRefused ? "context_length_exceeded"
      : serverCode === "structured_output_failed" ? "invalid_response"
      : response.status >= 500 ? "service_unavailable" : "invalid_request";
    const retry = Number(response.headers.get("retry-after"));
    return new ModelServiceError(code, response.status, response.headers.has("retry-after") && Number.isFinite(retry) && retry >= 0 ? Math.min(retry, 3600) : undefined, nativeRefused);
  }
}
