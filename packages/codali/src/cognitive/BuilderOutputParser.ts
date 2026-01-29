export type PatchAction =
  | {
      action: "replace";
      file: string;
      search_block: string;
      replace_block: string;
    }
  | {
      action: "create";
      file: string;
      content: string;
    }
  | {
      action: "delete";
      file: string;
    };

export type PatchFormat = "search_replace" | "file_writes";

export interface PatchPayload {
  patches: PatchAction[];
}

const assertString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Patch field '${field}' must be a non-empty string`);
  }
  return value;
};

const parsePatchAction = (raw: Record<string, unknown>): PatchAction => {
  const action = raw.action;
  if (action !== "replace" && action !== "create" && action !== "delete") {
    throw new Error("Patch action must be replace, create, or delete");
  }
  const file = assertString(raw.file, "file");
  if (action === "replace") {
    return {
      action,
      file,
      search_block: assertString(raw.search_block, "search_block"),
      replace_block: assertString(raw.replace_block, "replace_block"),
    };
  }
  if (action === "create") {
    return {
      action,
      file,
      content: assertString(raw.content, "content"),
    };
  }
  return { action, file };
};

const parseSearchReplacePayload = (payload: unknown): PatchPayload => {
  if (!payload || typeof payload !== "object") {
    throw new Error("Patch payload must be an object");
  }
  const patches = (payload as { patches?: unknown }).patches;
  if (!Array.isArray(patches) || patches.length === 0) {
    throw new Error("Patch payload must include patches array");
  }
  const parsed = patches.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Patch entry must be an object");
    }
    return parsePatchAction(entry as Record<string, unknown>);
  });
  return { patches: parsed };
};

const parseFileWritesPayload = (payload: unknown): PatchPayload => {
  if (!payload || typeof payload !== "object") {
    throw new Error("Patch payload must be an object");
  }
  const record = payload as { files?: unknown; delete?: unknown; patches?: unknown };
  if (Array.isArray(record.patches) && record.patches.length > 0) {
    return parseSearchReplacePayload(payload);
  }
  const files = record.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Patch payload must include files array");
  }
  const patches: PatchAction[] = files.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Patch file entry must be an object");
    }
    const file = assertString((entry as Record<string, unknown>).path, "path");
    const content = assertString((entry as Record<string, unknown>).content, "content");
    return { action: "create", file, content };
  });
  const deletes = record.delete;
  if (Array.isArray(deletes)) {
    for (const entry of deletes) {
      const file = assertString(entry, "delete");
      patches.push({ action: "delete", file });
    }
  }
  return { patches };
};

export const parsePatchOutput = (
  content: string,
  format: PatchFormat = "search_replace",
): PatchPayload => {
  if (!content.trim()) {
    throw new Error("Patch output is empty");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new Error("Patch output is not valid JSON");
  }
  if (format === "file_writes") {
    return parseFileWritesPayload(payload);
  }
  return parseSearchReplacePayload(payload);
};
