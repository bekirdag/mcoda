import { tmpdir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { assemblePrompt } from "@mcoda/core/prompt-assembler.js";
describe("prompt assembler", () => {
    it("includes docdex segments with chunking and headings", async () => {
        const dir = await fs.mkdtemp(path.join(tmpdir(), "mcoda-prompt-"));
        const docPath = path.join(dir, "doc.md");
        const content = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
        await fs.writeFile(docPath, content, "utf8");
        const result = await assemblePrompt({
            command: "pdr",
            agent: "test-agent",
            userPrompt: "Summarize the doc.",
            workspaceRoot: dir,
            docPaths: [docPath],
            docdexAllowPaths: [docPath],
            docdexChunkSize: 200,
            docdexMaxSegments: 3,
        });
        expect(result.docSegments.length).toBeLessThanOrEqual(3);
        expect(result.docSegments[0].path).toContain("doc.md");
        expect(result.prompt).toContain("## Documents (docdex)");
        expect(result.prompt).toContain("Summarize the doc.");
        expect(result.redactedPrompt.length).toBeGreaterThan(0);
    });
});
