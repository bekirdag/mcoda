import crypto from "node:crypto";

export interface SelfHostedInvocationTokenClaims {
  node_id: string;
  job_id: string;
  request_id: string;
  model: string;
  deadline_at: string;
  scope: "self_hosted.invoke";
  iat: number;
  exp: number;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signHmacSha256(input: string, secret: string): string {
  return base64UrlEncode(crypto.createHmac("sha256", secret).update(input).digest());
}

export function verifySelfHostedInvocationToken(input: {
  token: string;
  secret: string;
  nowSeconds?: number;
}): SelfHostedInvocationTokenClaims {
  const secret = requireText(input.secret, "self_hosted_invocation_secret");
  const token = requireText(input.token, "token");
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("self_hosted_invocation_token_invalid");
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = signHmacSha256(signingInput, secret);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(parts[2] || "");
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new Error("self_hosted_invocation_token_invalid");
  }

  let payload: SelfHostedInvocationTokenClaims;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8")) as SelfHostedInvocationTokenClaims;
  } catch {
    throw new Error("self_hosted_invocation_token_invalid");
  }
  const nowSeconds = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  if (payload.scope !== "self_hosted.invoke") {
    throw new Error("self_hosted_invocation_token_scope_denied");
  }
  if (!payload.exp || payload.exp < nowSeconds) {
    throw new Error("self_hosted_invocation_token_expired");
  }
  const deadlineMs = Date.parse(payload.deadline_at);
  if (!Number.isFinite(deadlineMs) || deadlineMs < nowSeconds * 1000) {
    throw new Error("self_hosted_invocation_token_expired");
  }
  requireText(payload.node_id, "node_id");
  requireText(payload.job_id, "job_id");
  requireText(payload.request_id, "request_id");
  requireText(payload.model, "model");
  return payload;
}
