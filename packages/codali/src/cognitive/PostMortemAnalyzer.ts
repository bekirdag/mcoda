import { readFile } from "node:fs/promises";
import type { DocdexClient } from "../docdex/DocdexClient.js";
import type { Provider } from "../providers/ProviderTypes.js";
import { RunLogReader } from "../runtime/RunLogReader.js";

export class PostMortemAnalyzer {
  constructor(
    private docdex: DocdexClient,
    private provider: Provider,
    private workspaceRoot: string
  ) {}

  async analyze(filePath: string): Promise<string | undefined> {
    const reader = new RunLogReader(this.workspaceRoot);
    const runId = await reader.findLastRunForFile(filePath);

    if (!runId) {
      throw new Error(`No recent Codali run found for ${filePath}`);
    }

    // 1. Get what Codali did (Builder Patch)
    const patchContent = await reader.getRunArtifact(runId, "builder-patch");
    if (!patchContent) {
        throw new Error(`Could not find builder patch for run ${runId}`);
    }

    // 2. Get current state (User's Fix)
    let currentContent = "";
    try {
        currentContent = await readFile(filePath, "utf8");
    } catch {
        throw new Error(`Could not read current file ${filePath}`);
    }

    // 3. Ask LLM to compare and extract a rule
    const prompt = `
ROLE: Post-Mortem Analyst
TASK: Compare the "CODALI PATCH" (what the agent tried to do) vs "CURRENT FILE" (what the user fixed/kept).
GOAL: Extract a specific preference or rule that the agent violated.

CODALI PATCH (JSON):
${patchContent}

CURRENT FILE CONTENT:
${currentContent}

INSTRUCTIONS:
1. Identify the difference between the patch and the current file.
2. Did the user revert the change? Or did they modify it?
3. Formulate a concise "Constraint Rule" to prevent this mistake in the future.
   - Example: "Prefer using 'axios' over 'fetch'."
   - Example: "Do not remove the 'export' keyword from helper functions."
4. If the changes are identical (no revert), output "NO_CHANGE".

OUTPUT FORMAT:
Return ONLY the rule string.
`;

    const response = await this.provider.generate({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
    });

    const rule = response.message.content?.trim();

    if (!rule || rule === "NO_CHANGE") {
        // Success case! The user kept the changes.
        // We should promote this as a Golden Example.
        const intent = await reader.getRunIntent(runId);
        if (intent && patchContent) {
            const memoryContent = `GOLDEN_EXAMPLE\nINTENT: ${intent}\nPATCH: ${patchContent}`;
            await this.docdex.memorySave(memoryContent);
            return "NO_CHANGE: Promoted to Golden Example.";
        }
        return undefined;
    }

    // 4. Save to Docdex Profile
    await this.docdex.savePreference("codali", "constraint", rule);
    
    return rule;
  }
}
