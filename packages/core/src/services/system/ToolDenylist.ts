import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_DENYLIST = ["gpt-creator"];
const DEFAULT_ALTERNATIVES = new Map<string, string[]>([
  ["gpt-creator", ["codex", "local-model"]],
]);

const parseDelimitedList = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeToolName = (value: string): string => value.trim().toLowerCase();

const parseConfigList = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    return parseDelimitedList(value);
  }
  return [];
};

const readConfigDenylist = async (mcodaDir?: string): Promise<string[]> => {
  if (!mcodaDir) return [];
  const configPath = path.join(mcodaDir, "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const configured =
      parsed?.tools?.denylist ??
      parsed?.toolDenylist ??
      parsed?.tool_denylist;
    return parseConfigList(configured);
  } catch {
    return [];
  }
};

export class ToolDenylist {
  private constructor(private readonly entries: Map<string, string[]>) {}

  static async load(options: {
    mcodaDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {}): Promise<ToolDenylist> {
    const env = options.env ?? process.env;
    const configEntries = await readConfigDenylist(options.mcodaDir);
    const envEntries = parseDelimitedList(env.MCODA_TOOL_DENYLIST);
    const combined = [...DEFAULT_DENYLIST, ...configEntries, ...envEntries];
    const entries = new Map<string, string[]>();
    for (const name of combined) {
      const normalized = normalizeToolName(name);
      if (!normalized || entries.has(normalized)) continue;
      entries.set(normalized, DEFAULT_ALTERNATIVES.get(normalized) ?? []);
    }
    return new ToolDenylist(entries);
  }

  list(): string[] {
    return Array.from(this.entries.keys());
  }

  match(name: string): string | undefined {
    const normalized = normalizeToolName(name);
    return this.entries.has(normalized) ? normalized : undefined;
  }

  findMatch(names: Array<string | undefined>): string | undefined {
    for (const name of names) {
      if (!name) continue;
      const match = this.match(name);
      if (match) return match;
    }
    return undefined;
  }

  formatViolation(matched: string): string {
    const alternatives = this.entries.get(matched) ?? [];
    const suggestion = alternatives.length
      ? `Suggested alternatives: ${alternatives.join(", ")}.`
      : "Use a supported agent or tool instead.";
    return `Tool '${matched}' is deprecated and blocked by the tool denylist. ${suggestion}`;
  }
}
