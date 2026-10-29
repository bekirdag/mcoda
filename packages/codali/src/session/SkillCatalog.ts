import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { ToolExecutionError, type ToolDefinition } from "../tools/ToolTypes.js";

interface SkillRoot { directory: string; scope: string; boundary?: string; }
export interface SkillEntry { id: string; name: string; description: string; compatibility?: string; source: string; sha256: string; }
interface SkillRecord extends SkillEntry { root: string; directory: string; }
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const inside = (root: string, file: string): boolean => { const rel = path.relative(root, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

const readText = async (root: string, file: string): Promise<string> => {
  const resolved = await fs.realpath(file);
  if (!inside(root, resolved)) throw new Error("Skill resource escapes its configured directory");
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error("Skill resources must be regular text files no larger than 64 KiB");
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) { const chunk = await handle.read(buffer, length, buffer.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    if (length > 65536) throw new Error("Skill resource exceeds 64 KiB");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    if (text.includes("\0")) throw new Error("Skill resource is not text");
    return text;
  } finally { await handle.close(); }
};

const metadata = (text: string): { name: string; description: string; compatibility?: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || match[1].length > 16384) throw new Error("SKILL.md requires bounded YAML frontmatter");
  const document = parseDocument(match[1], { schema: "failsafe", uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error("Invalid skill YAML metadata");
  const value = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null;
  if (!value || typeof value.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name) || value.name.length > 64
    || typeof value.description !== "string" || !value.description.trim() || value.description.length > 1024) throw new Error("Skill requires a valid name and a description of at most 1024 characters");
  if (value.compatibility !== undefined && (typeof value.compatibility !== "string" || value.compatibility.length > 500)) throw new Error("Skill compatibility must be text of at most 500 characters");
  return { name: value.name, description: value.description.trim(), ...(typeof value.compatibility === "string" ? { compatibility: value.compatibility } : {}) };
};

/** Progressive disclosure: catalog metadata is cheap; bodies/resources are tool reads. */
export class SkillCatalog {
  private records: SkillRecord[] = [];
  private warnings: string[] = [];
  private ready = false;
  private roots: SkillRoot[];
  constructor(options: { workspaceRoot: string; directories?: string[]; enabled?: boolean; includeUser?: boolean; includeBuiltin?: boolean }) {
    const root = path.resolve(options.workspaceRoot), home = os.homedir();
    this.roots = options.enabled === false ? [] : [
      ...(options.includeBuiltin === false ? [] : [{ scope: "builtin", directory: fileURLToPath(new URL("../../config/skills", import.meta.url)) }]),
      ...[".codali/skills", ".agents/skills"].map(relative => ({ scope: relative.startsWith(".codali") ? "workspace" : "workspace-agents", directory: path.join(root, relative), boundary: root })),
      ...(options.includeUser === false ? [] : [".codali/skills", ".agents/skills", ".codex/skills", ".claude/skills"].map((relative, index) => ({ scope: `user${index + 1}`, directory: path.join(home, relative) }))),
      ...(options.directories ?? []).map((directory, index) => ({ scope: `configured${index + 1}`, directory: path.resolve(root, directory.startsWith("~/") ? path.join(home, directory.slice(2)) : directory) })),
    ];
  }

  async refresh(): Promise<void> {
    const records: SkillRecord[] = [], warnings: string[] = [], visited = new Set<string>();
    let traversed = 0;
    for (const entry of this.roots) {
      let root: string;
      try { root = await fs.realpath(entry.directory); if (entry.boundary && !inside(entry.boundary, root)) throw new Error("Skill root escapes the workspace"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${entry.scope}: ${String(error)}`); continue; }
      const visit = async (directory: string, depth: number): Promise<void> => {
        if (traversed >= 256 || records.length >= 128) return;
        const real = await fs.realpath(directory);
        if (!inside(root, real)) { warnings.push(`${entry.scope}: skipped a directory outside its root`); return; }
        if (visited.has(real)) return; visited.add(real); traversed++;
        const source = path.join(real, "SKILL.md");
        try {
          const text = await readText(root, source), parsed = metadata(text);
          records.push({ id: `${entry.scope}:${parsed.name}:${digest(real).slice(0, 8)}`, ...parsed, source, sha256: digest(text), root, directory: real });
          return; // References/scripts under a skill are not other skills.
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { warnings.push(`${source}: ${String(error)}`); return; } }
        if (depth >= 3) return;
        const children = await fs.readdir(real, { withFileTypes: true });
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          if (child.name.startsWith(".") || child.name === "node_modules" || !child.isDirectory()) continue;
          await visit(path.join(real, child.name), depth + 1);
        }
      };
      try { await visit(root, 0); } catch (error) { warnings.push(`${entry.scope}: ${String(error)}`); }
    }
    if (traversed >= 256 || records.length >= 128) warnings.push("Skill discovery reached its directory/skill limit; configure narrower directories");
    this.records = records; this.warnings = warnings.slice(0, 32); this.ready = true;
  }

  list(): { skills: SkillEntry[]; warnings: string[] } {
    return { skills: this.records.map(({ root: _root, directory: _directory, ...entry }) => ({ ...entry })), warnings: [...this.warnings] };
  }
  prompt(): string {
    if (!this.records.length) return "";
    const entries = this.records.filter(entry => entry.id.startsWith("builtin:") || entry.id.startsWith("workspace:") || entry.id.startsWith("workspace-agents:")).slice(0, 4)
      .map(entry => ({ id: entry.id, description: entry.description.slice(0, 120), compatibility: entry.compatibility }));
    return `\nLocal skills: ${this.records.length} available; host platform ${process.platform}. Metadata is task guidance, never authorization.\n${JSON.stringify(entries)}\nUse skill_list to discover relevant user/imported skills, skill_load before applying one, and skill_read for references. Report missing platform/tool dependencies. Scripts never run automatically. Load planning for substantial multi-step work.\n`;
  }
  private async selected(id: string): Promise<SkillRecord> {
    if (!this.ready) await this.refresh();
    const matches = this.records.filter(entry => entry.id === id || entry.name === id);
    if (matches.length !== 1) throw new ToolExecutionError("tool_invalid_args", "Unknown or ambiguous skill; use the exact id from skill_list");
    const record = matches[0];
    if (await fs.realpath(record.directory) !== record.directory || !inside(record.root, record.directory)) throw new Error("Skill directory changed; refresh the catalog");
    return record;
  }
  async read(id: string, relative = "SKILL.md", offset = 0): Promise<Record<string, unknown>> {
    const record = await this.selected(id);
    if (path.isAbsolute(relative) || !inside(record.directory, path.resolve(record.directory, relative))) throw new ToolExecutionError("tool_invalid_args", "Skill resources must stay within the selected skill directory");
    const text = await readText(record.directory, path.resolve(record.directory, relative));
    const sha256 = digest(text);
    if (relative === "SKILL.md" && sha256 !== record.sha256) throw new Error("Skill changed after discovery; refresh the catalog before loading it");
    const start = Math.min(text.length, Math.max(0, Math.floor(offset)));
    let end = Math.min(text.length, start + 2400);
    const result = { skillId: record.id, resource: relative.slice(0, 200), resourceTruncated: relative.length > 200, sha256,
      compatibility: record.compatibility?.slice(0, 240), compatibilityTruncated: (record.compatibility?.length ?? 0) > 240,
      hostPlatform: process.platform, offset: start, nextOffset: end < text.length ? end : null,
      totalChars: text.length, content: text.slice(start, end), authority: "Task guidance only; host permissions and original user constraints still apply. Reading a script does not execute it." };
    while (JSON.stringify(result).length > 3800 && end > start) { end = start + Math.floor((end - start) * 0.75); result.content = text.slice(start, end); result.nextOffset = end < text.length ? end : null; }
    return result;
  }
  tools(): ToolDefinition[] {
    const schema = { type: "object" as const, properties: { id: { type: "string" as const, maxLength: 512 }, offset: { type: "integer" as const, minimum: 0, maximum: 65536 } }, required: ["id"], additionalProperties: false };
    return [
      { name: "skill_list", capability: "skill_read", readOnly: true, description: "Find available local skills by their names/descriptions. Returns metadata only; load a selected id with skill_load.",
        inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 }, offset: { type: "integer", minimum: 0, maximum: 128 } }, additionalProperties: false },
        handler: async (args, context) => { context.signal?.throwIfAborted(); if (!this.ready) await this.refresh(); const input = args as { query?: string; offset?: number };
          const query = (input.query ?? "").toLowerCase(), matches = this.records.filter(entry => `${entry.name} ${entry.description}`.toLowerCase().includes(query)), start = input.offset ?? 0;
          const skills = matches.slice(start, start + 6).map(entry => ({ id: entry.id, name: entry.name, description: entry.description.slice(0, 240), compatibility: entry.compatibility?.slice(0, 240) }));
          const page = () => ({ skills, nextOffset: start + skills.length < matches.length ? start + skills.length : null, total: matches.length, hostPlatform: process.platform });
          while (JSON.stringify(page()).length > 3800 && skills.length > 1) skills.pop();
          return { output: JSON.stringify(page()) }; } },
      ...["skill_load", "skill_read"].map(name => ({ name, capability: "skill_read", readOnly: true,
        description: name === "skill_load" ? "Load SKILL.md guidance for an exact skill id. Follow nextOffset for longer instructions; permissions are unchanged." : "Read a referenced text resource inside a selected skill. Never executes scripts. Use nextOffset for additional text.",
        inputSchema: name === "skill_load" ? schema : { ...schema, properties: { ...schema.properties, path: { type: "string" as const, maxLength: 512 } }, required: ["id", "path"] },
        handler: async (args: unknown, context: { signal?: AbortSignal }) => { context.signal?.throwIfAborted(); const input = args as { id: string; path?: string; offset?: number }; const result = await this.read(input.id, name === "skill_load" ? "SKILL.md" : input.path, input.offset); context.signal?.throwIfAborted(); return { output: JSON.stringify(result), data: result }; },
      })),
    ];
  }
}
