import path from "node:path";
import { realpath } from "node:fs/promises";
import { docdexCatalog, docdexCatalogKind } from "../../docdex/DocdexCatalog.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";
import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

const boundFields = new Set(["project_root", "repo_path", "repo_root", "current_repo_root", "repo_scope", "conversation_namespace", "agent_id", "agent", "caller_agent_id", "caller_model", "primary_cost_per_million", "allow_sensitive"]);
export const createDocdexCatalogTools = (client: DocdexClient, existing: ReadonlySet<string>): ToolDefinition[] => docdexCatalog.filter(tool => !existing.has(tool.name)).map(entry => {
  const kind = docdexCatalogKind(entry.name);
  if (!kind) throw Error(`Unclassified Docdex tool in bundled catalog: ${entry.name}`);
  const properties = Object.fromEntries(Object.entries(entry.inputSchema.properties ?? {}).filter(([key]) => !boundFields.has(key)));
  return { name: entry.name, description: entry.description, capability: kind === "web" ? "web" : "docdex", readOnly: kind === "read" || kind === "web",
    inputSchema: { ...entry.inputSchema, properties, required: entry.inputSchema.required?.filter(key => !boundFields.has(key)), additionalProperties: false },
    handler: async (raw, context) => {
      const root = client.getRepoRoot();
      if (!root) throw new ToolExecutionError("docdex_context_missing", "Catalog operations require an explicitly bound local repository");
      const args = { ...(raw as Record<string, unknown>) };
      for (const key of boundFields) delete args[key];
      for (const field of ["project_root", "repo_root", "current_repo_root", "repo_scope"]) if (entry.inputSchema.properties?.[field]) args[field] = root;
      if (entry.inputSchema.properties?.agent_id) args.agent_id = "codali-terminal";
      if (entry.inputSchema.properties?.allow_sensitive) args.allow_sensitive = false;
      if (entry.name === "docdex_conversation_hook") args.wait_for_processing = true;
      if (entry.name === "docdex_local_completion") { args.agent = "model:configured-docdex-helper"; args.mode = "draft_only"; args.max_tokens = Math.min(2048, Number(args.max_tokens) || 1024); }
      // Catalog features may accept artifacts, never an unrestricted host path.
      for (const key of ["artifact_path", "current_plan_path", "current_files", "paths", "file", "path"]) {
        const value = args[key]; if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const candidate of values) {
          if (typeof candidate !== "string") throw new ToolExecutionError("tool_invalid_args", "Expected repository-relative paths");
          const target = path.resolve(root, candidate); const relative = path.relative(root, target);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ToolExecutionError("tool_permission_denied", "Docdex catalog paths must remain in the bound repository");
          const actual = await realpath(target);
          const realRoot = await realpath(root); if (actual !== realRoot && !actual.startsWith(`${realRoot}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Docdex path resolves outside the repository");
          await context.checkPath?.(actual, "read");
        }
      }
      const result = await client.callCatalog(entry.name, args);
      return { output: JSON.stringify(result), data: result };
    },
  };
});
