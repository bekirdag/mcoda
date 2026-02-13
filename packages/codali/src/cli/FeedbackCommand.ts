import path from "node:path";
import process from "node:process";
import { DocdexClient } from "../docdex/DocdexClient.js";
import { createProvider } from "../providers/ProviderRegistry.js";
import { PostMortemAnalyzer } from "../cognitive/PostMortemAnalyzer.js";
import { resolveWorkspaceRoot } from "./RunCommand.js";
import { loadConfig } from "../config/ConfigLoader.js";

export class FeedbackCommand {
  static async run(argv: string[]): Promise<void> {
    const fileIndex = argv.indexOf("--file");
    const filePath = fileIndex !== -1 ? argv[fileIndex + 1] : argv[0];

    if (!filePath || filePath.startsWith("-")) {
      throw new Error("Usage: codali learn --file <path/to/file>");
    }

    const workspaceRoot = resolveWorkspaceRoot(process.cwd());
    const config = await loadConfig({ cwd: workspaceRoot });

    // Prefer architect routing overrides for the learning analysis phase.
    const providerName = config.routing?.architect?.provider ?? config.provider;
    const providerModel = config.routing?.architect?.model ?? config.model;
    if (!providerName || !providerModel) {
      throw new Error("No provider/model configured. Use --provider/--model or configure codali.");
    }

    const provider = createProvider(providerName, {
      model: providerModel,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
    
    const docdexClient = new DocdexClient({
        baseUrl: config.docdex.baseUrl,
        repoId: config.docdex.repoId,
        repoRoot: config.docdex.repoRoot ?? config.workspaceRoot,
    });

    const analyzer = new PostMortemAnalyzer(docdexClient, provider, workspaceRoot);
    
    // eslint-disable-next-line no-console
    console.log(`Analyzing history for ${filePath}...`);
    
    try {
        const rule = await analyzer.analyze(filePath);
        if (rule) {
            // eslint-disable-next-line no-console
            console.log(`\n✅ Learned new constraint: "${rule}"`);
            // eslint-disable-next-line no-console
            console.log("Saved to Docdex Profile Memory.");
        } else {
            // eslint-disable-next-line no-console
            console.log("\nNo significant deviation found or no clear rule extracted.");
        }
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`\n❌ Analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
