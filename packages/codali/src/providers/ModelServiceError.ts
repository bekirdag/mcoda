export type ModelServiceErrorCode = "authentication_failed" | "entitlement_missing" | "quota_exhausted" | "rate_limited" | "service_unavailable" | "model_unavailable" | "invalid_request";

/** Transport diagnostics contain stable classifications, never an upstream body. */
export class ModelServiceError extends Error {
  constructor(readonly code: ModelServiceErrorCode, readonly status: number, readonly retryAfterSeconds?: number) {
    super(`Model service HTTP ${status}: ${code}${code === "authentication_failed" ? "; authenticate with codali login" : ""}`);
    this.name = "ModelServiceError";
  }

  static async fromResponse(response: Response): Promise<ModelServiceError> {
    let serverCode = "";
    if (response.body) {
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 8192) break; chunks.push(part.value); }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { code?: unknown }; code?: unknown };
        if (typeof (payload.error?.code ?? payload.code) === "string") serverCode = String(payload.error?.code ?? payload.code);
      } catch { /* The status still supplies a safe classification. */ }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
    const code: ModelServiceErrorCode = response.status === 401 ? "authentication_failed"
      : response.status === 403 ? "entitlement_missing"
      : ["quota_exceeded", "quota_exhausted", "insufficient_quota", "credits_exhausted", "insufficient_credits"].includes(serverCode) || response.status === 402 ? "quota_exhausted"
      : response.status === 429 ? "rate_limited"
      : response.status === 404 ? "model_unavailable"
      : response.status >= 500 ? "service_unavailable" : "invalid_request";
    const retry = Number(response.headers.get("retry-after"));
    return new ModelServiceError(code, response.status, response.headers.has("retry-after") && Number.isFinite(retry) && retry >= 0 ? Math.min(retry, 3600) : undefined);
  }
}
