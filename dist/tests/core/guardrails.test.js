import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runGuardrails, defaultGuardrailSuite } from "@mcoda/core/guardrails.js";
const makeTempRepo = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mcoda-guardrails-"));
    mkdirSync(path.join(dir, "openapi"), { recursive: true });
    mkdirSync(path.join(dir, "src"), { recursive: true });
    return dir;
};
describe("guardrails", () => {
    let repoRoot;
    beforeEach(() => {
        repoRoot = makeTempRepo();
    });
    afterEach(() => {
        rmSync(repoRoot, { recursive: true, force: true });
    });
    it("fails when OpenAPI spec is missing", async () => {
        const results = await runGuardrails(defaultGuardrailSuite, { repoRoot });
        const openapiResult = results.find((r) => r.id === "openapi-source-of-truth");
        expect(openapiResult?.status).toBe("fail");
    });
    it("passes OpenAPI rule when spec exists", async () => {
        writeFileSync(path.join(repoRoot, "openapi", "mcoda.yaml"), "openapi: 3.1.0");
        writeFileSync(path.join(repoRoot, ".gitignore"), ".mcoda/\n");
        const results = await runGuardrails(defaultGuardrailSuite, { repoRoot });
        const openapiResult = results.find((r) => r.id === "openapi-source-of-truth");
        expect(openapiResult?.status).toBe("pass");
    });
    it("fails when .gitignore does not include .mcoda", async () => {
        writeFileSync(path.join(repoRoot, "openapi", "mcoda.yaml"), "openapi: 3.1.0");
        writeFileSync(path.join(repoRoot, ".gitignore"), "node_modules/\n");
        const results = await runGuardrails(defaultGuardrailSuite, { repoRoot });
        const gitignoreResult = results.find((r) => r.id === "gitignore-mcoda");
        expect(gitignoreResult?.status).toBe("fail");
    });
    it("warns when workspace state directory is missing", async () => {
        writeFileSync(path.join(repoRoot, "openapi", "mcoda.yaml"), "openapi: 3.1.0");
        writeFileSync(path.join(repoRoot, ".gitignore"), ".mcoda/\n");
        const results = await runGuardrails(defaultGuardrailSuite, { repoRoot });
        const stateResult = results.find((r) => r.id === "workspace-state-dir");
        expect(stateResult?.status).toBe("warn");
    });
});
