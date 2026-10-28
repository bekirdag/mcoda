import type { ProviderMessage } from "../providers/ProviderTypes.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Prepare inference context only. Original tool receipts remain in the audit log. */
export function preparedDocdexMessage(message: ProviderMessage): ProviderMessage {
  if (message.role !== "tool" || !message.name?.startsWith("docdex_")) return message;
  // The controller appends a receipt handle after the JSON result. Preserve it
  // verbatim; it is evidence identity, not removable transport diagnostics.
  const receipt = message.content.match(/\n\n\[Tool metadata: invocation receipt ID [a-f0-9-]{36}; receiptRef=receipt:[a-f0-9]+\]$/u)?.[0] ?? "";
  const body = receipt ? message.content.slice(0, -receipt.length) : message.content;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return message; }
  if (!record(value) || "error" in value || "errors" in value) return message;
  const result = { ...value };
  for (const key of ["repo_id", "repoId", "repo_root", "project_root", "state_dir", "schema"]) delete result[key];
  if (record(result.meta)) {
    const meta = { ...result.meta };
    delete meta.docdex_request_id; delete meta.docdex_operation;
    if (Object.keys(meta).length) result.meta = meta;
    else delete result.meta;
  }
  if (message.name === "docdex_search") {
    if (Array.isArray(result.hits) && Array.isArray(result.results)
      && JSON.stringify(result.hits) === JSON.stringify(result.results)) delete result.results;
    for (const key of ["hits", "results"]) if (Array.isArray(result[key])) {
      result[key] = result[key].map((hit: unknown) => {
        if (!record(hit)) return hit;
        const prepared = { ...hit };
        delete prepared.score_breakdown; delete prepared.retrieval_explanation;
        if (typeof prepared.summary === "string" && typeof prepared.snippet === "string"
          && normalize(prepared.summary) === normalize(prepared.snippet)) delete prepared.summary;
        return prepared;
      });
    }
  }
  const content = JSON.stringify(result) + receipt;
  return content.length < message.content.length ? { ...message, content } : message;
}
