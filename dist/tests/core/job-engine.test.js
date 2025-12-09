import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { JobEngine } from "@mcoda/core/job-engine.js";
import { createWorkspaceService } from "@mcoda/core/services.js";
const makeWorkspace = () => mkdtempSync(path.join(tmpdir(), "mcoda-job-engine-"));
describe("JobEngine", () => {
    let workspace;
    beforeEach(() => {
        workspace = makeWorkspace();
    });
    afterEach(() => {
        rmSync(workspace, { recursive: true, force: true });
    });
    it("creates checkpoints, logs phases, and links token_usage to runs", async () => {
        const engine = await JobEngine.create({ workspaceRoot: workspace });
        await engine.startJob("work-on-tasks", "job-123", { note: "test" });
        engine.logPhase("git:branches", "ok", { base: "main", integration: "mcoda-dev" });
        const taskRunId = engine.recordTaskRun({
            taskId: "TASK-1",
            command: "work-on-tasks",
            status: "in_progress",
            jobId: "job-123",
        });
        engine.recordTokenUsage({
            command: "work-on-tasks",
            taskId: "TASK-1",
            taskRunId,
            jobId: "job-123",
            promptTokens: 10,
            completionTokens: 5,
        });
        await engine.checkpoint("midway", { marker: true });
        const checkpoint = await engine.loadCheckpoint("job-123");
        expect(checkpoint?.stage).toBe("midway");
        expect(checkpoint?.commandRunId).toBeDefined();
        engine.finalize("succeeded", "done");
        const store = await createWorkspaceService({ workspaceRoot: workspace });
        const tokens = store.listTokenUsage({ limit: 5 });
        expect(tokens[0]?.taskRunId).toBe(taskRunId);
        expect(tokens[0]?.jobId).toBe("job-123");
        const job = store.getJob("job-123");
        expect(job?.status).toBe("completed");
    });
});
