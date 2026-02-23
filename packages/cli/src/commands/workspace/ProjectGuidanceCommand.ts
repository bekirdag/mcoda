import path from "node:path";
import { WorkspaceResolver, ensureProjectGuidance } from "@mcoda/core";

const USAGE =
  "Usage: mcoda project-guidance [--workspace <path>|--workspace-root <path>] [--force] [--json]";

export interface ParsedProjectGuidanceArgs {
  workspaceRoot?: string;
  force: boolean;
  json: boolean;
  help: boolean;
}

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return defaultValue;
};

export const parseProjectGuidanceArgs = (argv: string[]): ParsedProjectGuidanceArgs => {
  const parsed: ParsedProjectGuidanceArgs = {
    force: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--workspace-root=") || arg.startsWith("--workspace=")) {
      const [, raw] = arg.split("=", 2);
      if (raw) parsed.workspaceRoot = path.resolve(raw);
      continue;
    }
    if (arg.startsWith("--force=")) {
      const [, raw] = arg.split("=", 2);
      parsed.force = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--json=")) {
      const [, raw] = arg.split("=", 2);
      parsed.json = parseBooleanFlag(raw, true);
      continue;
    }
    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        if (argv[i + 1]) {
          parsed.workspaceRoot = path.resolve(argv[i + 1]);
          i += 1;
        }
        break;
      case "--force": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          parsed.force = parseBooleanFlag(next, true);
          i += 1;
        } else {
          parsed.force = true;
        }
        break;
      }
      case "--json":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        break;
    }
  }
  return parsed;
};

export class ProjectGuidanceCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseProjectGuidanceArgs(argv);
    if (parsed.help) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }

    try {
      const workspace = await WorkspaceResolver.resolveWorkspace({
        cwd: process.cwd(),
        explicitWorkspace: parsed.workspaceRoot,
      });
      const result = await ensureProjectGuidance(workspace.workspaceRoot, {
        mcodaDir: workspace.mcodaDir,
        force: parsed.force,
      });
      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              workspaceRoot: workspace.workspaceRoot,
              mcodaDir: workspace.mcodaDir,
              path: result.path,
              status: result.status,
            },
            null,
            2,
          ),
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`project-guidance ${result.status}: ${result.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`project-guidance failed: ${message}`);
      process.exitCode = 1;
    }
  }
}
