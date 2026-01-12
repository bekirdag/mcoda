import { createHash } from "node:crypto";

export interface TaskCommentSlugInput {
  source: string;
  message: string;
  file?: string | null;
  line?: number | null;
  category?: string | null;
}

export interface TaskCommentFormatInput {
  slug: string;
  source: string;
  message: string;
  status?: string | null;
  category?: string | null;
  file?: string | null;
  line?: number | null;
  suggestedFix?: string | null;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

const normalizePath = (value: string): string =>
  value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");

const buildStableHash = (input: string): string => createHash("sha1").update(input).digest("hex").slice(0, 8);

export const createTaskCommentSlug = (input: TaskCommentSlugInput): string => {
  const baseParts = [
    input.source,
    input.category ?? undefined,
    input.file ? normalizePath(input.file) : undefined,
    typeof input.line === "number" ? `L${input.line}` : undefined,
  ].filter(Boolean) as string[];
  const base = slugify(baseParts.join("-")) || "comment";
  const trimmedBase = base.length > 60 ? base.slice(0, 60).replace(/-+$/g, "") : base;
  const hashInput = [
    input.source,
    input.category ?? "",
    input.file ?? "",
    typeof input.line === "number" ? String(input.line) : "",
    input.message.trim(),
  ].join("|");
  return `${trimmedBase || "comment"}-${buildStableHash(hashInput)}`;
};

export const formatTaskCommentBody = (input: TaskCommentFormatInput): string => {
  const message = input.message.trim() || "(no details provided)";
  const suggestedFix = input.suggestedFix?.trim();
  const location =
    input.file && typeof input.line === "number"
      ? `${normalizePath(input.file)}:${input.line}`
      : input.file
        ? normalizePath(input.file)
        : undefined;
  const lines = [
    "[task-comment]",
    `slug: ${input.slug}`,
    `source: ${input.source}`,
    input.category ? `category: ${input.category}` : undefined,
    `status: ${input.status ?? "open"}`,
    location ? `location: ${location}` : undefined,
    "message:",
    message,
  ].filter(Boolean) as string[];
  if (suggestedFix) {
    lines.push("");
    lines.push("suggested_fix:");
    lines.push(suggestedFix);
  }
  return lines.join("\n");
};
