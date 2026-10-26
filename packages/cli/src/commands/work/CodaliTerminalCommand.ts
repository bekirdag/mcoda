import { promises as fs } from "node:fs";
import { PathHelper } from "@mcoda/shared";
import { McodaProjectTaskAuthority } from "@mcoda/core";
import { WorkspaceRepository } from "@mcoda/db";
import { TerminalCommand, parseTerminalArguments } from "@mcoda/codali";

export class CodaliTerminalCommand {
  static async run(argv: string[]): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) { await TerminalCommand.run(argv); return; }
    const input = argv.length && !argv[0].startsWith("--") ? argv : ["chat", ...argv];
    const args = parseTerminalArguments(input);
    const root = await fs.realpath(args.workspaceRoot);
    let repo: WorkspaceRepository | undefined;
    try {
      // Ordinary Git repositories remain ordinary Git repositories: never create a project DB here.
      try { await fs.access(PathHelper.getWorkspaceDbPath(root)); repo = await WorkspaceRepository.create(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (args.projectTask && !repo) throw new Error("This workspace has no mcoda project database");
      await TerminalCommand.run(input, { projectTaskAuthority: repo ? new McodaProjectTaskAuthority(repo) : undefined });
    } finally { await repo?.close(); }
  }
}
