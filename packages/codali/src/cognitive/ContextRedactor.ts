import { promises as fs } from "node:fs";
import path from "node:path";

export interface ContextRedactorOptions {
  workspaceRoot: string;
  ignoreFilesFrom: string[];
  redactPatterns: string[];
}

const toPosixPath = (input: string): string => input.split(path.sep).join("/");

const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
};

const parseIgnoreFile = async (filePath: string): Promise<string[]> => {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
};

export class ContextRedactor {
  private matchers: RegExp[] = [];
  private regexes: RegExp[];

  constructor(private options: ContextRedactorOptions) {
    this.regexes = options.redactPatterns.map((pattern) => new RegExp(pattern, "g"));
  }

  async loadIgnoreMatchers(): Promise<void> {
    const patterns: string[] = [];
    for (const ignoreFile of this.options.ignoreFilesFrom) {
      const ignorePath = path.resolve(this.options.workspaceRoot, ignoreFile);
      const entries = await parseIgnoreFile(ignorePath);
      patterns.push(...entries);
    }
    this.matchers = patterns.map(globToRegex);
  }

  shouldIgnore(relativePath: string): boolean {
    const normalized = toPosixPath(relativePath);
    return this.matchers.some((matcher) => matcher.test(normalized));
  }

  redact(content: string): { content: string; redactions: number } {
    let redactions = 0;
    let output = content;
    for (const regex of this.regexes) {
      output = output.replace(regex, (match) => {
        redactions += 1;
        return "<redacted>";
      });
    }
    return { content: output, redactions };
  }
}
