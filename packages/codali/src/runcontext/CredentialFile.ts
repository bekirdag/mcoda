import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Reads operator credentials from `~/.codali/.creds`.
 *
 * Config files reference secrets indirectly (`env:GITHUB_TOKEN`) so a config
 * can be read, diffed, and shared without leaking anything. That indirection is
 * only useful if the values live somewhere convenient, and exporting shell
 * variables before every command is not convenient.
 *
 * ## Why only the user-level file
 *
 * This deliberately does **not** read a `.creds` from the workspace. A
 * checked-out repository is untrusted input — the same reason
 * `scrubRepoConfig` refuses repository-supplied credentials. A repo that
 * shipped its own `.creds` could silently substitute the token used for a
 * connector the user configured. Credentials come from the operator's home
 * directory or the process environment, never from the tree being analysed.
 *
 * Format is dotenv-style: `KEY=value`, `#` comments, optional quotes.
 */

const CREDS_FILE = path.join(homedir(), ".codali", ".creds");

let cache: Record<string, string> | undefined;

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

export const parseCredentialFile = (contents: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // `export FOO=bar` is accepted so the same file can also be sourced by a shell.
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!key) continue;
    values[key] = stripQuotes(withoutExport.slice(separator + 1));
  }
  return values;
};

export const loadCredentialFile = (
  filePath: string = CREDS_FILE,
  forceReload = false,
): Record<string, string> => {
  if (cache && !forceReload) return cache;
  if (!existsSync(filePath)) {
    cache = {};
    return cache;
  }
  try {
    cache = parseCredentialFile(readFileSync(filePath, "utf8"));
  } catch {
    // An unreadable creds file must not stop a run; the connector will fail
    // with a clearer authentication error than anything raised here.
    cache = {};
  }
  return cache;
};

/**
 * Resolves a credential name. The process environment wins over the file, so a
 * one-off `GITHUB_TOKEN=… codali ask …` overrides the stored value without
 * editing anything.
 */
export const resolveCredential = (name: string): string | undefined =>
  process.env[name] ?? loadCredentialFile()[name];

/** Test-only: drops the cached file so a fresh read can be exercised. */
export const resetCredentialCache = (): void => {
  cache = undefined;
};

export const credentialFilePath = (): string => CREDS_FILE;
