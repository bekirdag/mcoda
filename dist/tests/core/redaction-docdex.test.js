import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { DocdexClient } from "@mcoda/core/docdex.js";
import { redactText } from "@mcoda/core/redaction.js";
import { assemblePrompt } from "@mcoda/core/prompt-assembler.js";
const makeWorkspace = () => mkdtempSync(path.join(tmpdir(), "mcoda-redaction-"));
describe("redaction + docdex boundaries", () => {
    let workspace;
    beforeEach(() => {
        workspace = makeWorkspace();
    });
    afterEach(() => {
        rmSync(workspace, { recursive: true, force: true });
    });
    it("redacts common secret shapes", () => {
        const raw = "Authorization: Bearer abcdef123456789\napiKey=sk-abc1234567890000\nsecret=supersecretvalue";
        const redacted = redactText(raw);
        expect(redacted).not.toContain("abcdef123456789");
        expect(redacted).not.toContain("sk-abc1234567890000");
        expect(redacted).not.toContain("supersecretvalue");
    });
    it("blocks docdex reads from .mcoda", async () => {
        const blockedDir = path.join(workspace, ".mcoda");
        mkdirSync(blockedDir, { recursive: true });
        writeFileSync(path.join(blockedDir, "secret.txt"), "sk-should-not-leak");
        const client = new DocdexClient({ workspaceRoot: workspace });
        await expect(client.fetchSegments([path.join(blockedDir, "secret.txt")])).rejects.toThrow(/blocked/);
    });
    it("allows allowed doc path and redacts content before returning", async () => {
        const docsDir = path.join(workspace, "docs");
        mkdirSync(docsDir, { recursive: true });
        writeFileSync(path.join(docsDir, "sds.md"), "apiKey=sk-abc1234567890000\nSafe content");
        const client = new DocdexClient({ workspaceRoot: workspace, allowPaths: [docsDir] });
        const segments = await client.fetchSegments([path.join(docsDir, "sds.md")]);
        expect(segments).toHaveLength(1);
        expect(segments[0].content).not.toContain("sk-abc1234567890000");
        const assembly = await assemblePrompt({
            command: "test-agent",
            agent: "primary",
            userPrompt: "Summarize the SDS doc.",
            workspaceRoot: workspace,
            docPaths: [path.join(docsDir, "sds.md")],
        });
        expect(assembly.redactedPrompt).not.toContain("sk-abc1234567890000");
        expect(assembly.docSegments).toHaveLength(1);
    });
});
