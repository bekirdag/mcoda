import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodaliAdapter } from "@mcoda/agents";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskSelectionService } from "../TaskSelectionService.js";
import { TaskStateService } from "../TaskStateService.js";
import { WorkOnTasksService } from "../WorkOnTasksService.js";
import { JobService } from "../../jobs/JobService.js";
import { GATEWAY_HANDOFF_ENV_PATH } from "../../agents/GatewayHandoff.js";

let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;
let originalPatchMode: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalProfile = process.env.USERPROFILE;
  originalPatchMode = process.env.MCODA_WORK_ON_TASKS_PATCH_MODE;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-work-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.MCODA_WORK_ON_TASKS_PATCH_MODE = "1";
});

afterEach(async () => {
  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalProfile;
  }
  if (originalPatchMode === undefined) {
    delete process.env.MCODA_WORK_ON_TASKS_PATCH_MODE;
  } else {
    process.env.MCODA_WORK_ON_TASKS_PATCH_MODE = originalPatchMode;
  }
});

class StubAgentService {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceNoPlus {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "hello world",
      "*** End Patch",
      "```",
    ].join("\n");
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceAbsolutePatch {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- /dev/null",
      "+++ FILE: tests/absolute.txt",
      "@@ -0,0 +1,1 @@",
      "+hello world",
      "```",
    ].join("\n");
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceOutOfScopePatch {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- a/../outside.txt",
      "+++ b/../outside.txt",
      "@@ -1 +1 @@",
      "-foo",
      "+bar",
      "```",
    ].join("\n");
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceAddPatchMissingFile {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- a/tests/newfile.txt",
      "+++ b/tests/newfile.txt",
      "@@ -0,0 +1,1 @@",
      "+hello world",
      "```",
    ].join("\n");
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceLargeDocDeletion {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke() {
    const removed = Array.from({ length: 120 }, (_, i) => `-line ${i + 1}`).join("\n");
    const patch = [
      "```patch",
      "--- a/docs/sds/guard.md",
      "+++ b/docs/sds/guard.md",
      "@@ -1,120 +1,1 @@",
      removed,
      "+line 1",
      "```",
    ].join("\n");
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceCapture {
  lastInput: string | null = null;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, req: any) {
    this.lastInput = req?.input ?? null;
    const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceCaptureRequest {
  lastRequest: any | null = null;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, req: any) {
    this.lastRequest = req ?? null;
    const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceStreamable {
  streamCalls = 0;
  invokeCalls = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invokeCalls += 1;
    const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
    return { output: patch, adapter: "local-model" };
  }
  async *invokeStream(_id: string, _req: any) {
    this.streamCalls += 1;
    const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
    yield { output: patch } as any;
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceCodaliAdapter {
  lastRequest: any | null = null;
  private adapter: CodaliAdapter;
  private agent: any;

  constructor() {
    this.agent = {
      id: "agent-1",
      slug: "agent-1",
      adapter: "openai-api",
      defaultModel: "stub-model",
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.adapter = new CodaliAdapter({
      agent: this.agent,
      capabilities: ["code_write"],
      model: "stub-model",
      apiKey: "test-key",
      adapter: "codali-cli",
    });
  }

  async resolveAgent() {
    return this.agent;
  }

  async invoke(_id: string, req: any) {
    this.lastRequest = req ?? null;
    return this.adapter.invoke(req);
  }

  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceCommentResolution {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "--- a/tmp.txt",
      "+++ b/tmp.txt",
      "@@ -1 +1 @@",
      "-foo",
      "+bar",
      "",
    ].join("\n");
    return {
      output: JSON.stringify({
        patch,
        resolvedSlugs: ["review-open"],
        unresolvedSlugs: ["review-resolved"],
      }),
      adapter: "local-model",
    };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceNoChangeCommentResolution {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    return {
      output: JSON.stringify({
        resolvedSlugs: ["review-open"],
        unresolvedSlugs: [],
      }),
      adapter: "local-model",
    };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceBacklogMissing {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "--- a/tmp.txt",
      "+++ b/tmp.txt",
      "@@ -1 +1 @@",
      "-foo",
      "+bar",
      "",
    ].join("\n");
    return {
      output: JSON.stringify({
        patch,
        commentBacklogStatus: "none",
      }),
      adapter: "local-model",
    };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceNoChange {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const output = ["FILE: existing.txt", "```", "no-op", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceFallbackFileOverwrite {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    if (this.invocations === 1) {
      const patch = ["```patch", "--- a/existing.txt", "+++ b/existing.txt", "@@", "-before", "+after", "```"].join("\n");
      return { output: patch, adapter: "local-model" };
    }
    const output = ["FILE: existing.txt", "```", "fallback overwrite", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceFallbackInvalid {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    if (this.invocations === 1) {
      const patch = ["```patch", "--- a/existing.txt", "+++ b/existing.txt", "@@", "-before", "+after", "```"].join("\n");
      return { output: patch, adapter: "local-model" };
    }
    const output = ["```ts", "console.log('fallback');", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceFileBlockDiffPrefix {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const output = ["FILE: b/dir/new.txt", "```", "prefixed content", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceFileBlockWithMetadata {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const output = ["FILE: new.txt (new file)", "```", "metadata content", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceBulletFile {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const output = ["- FILE: `bullet.txt`", "```", "bullet content", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceJsonPlanThenPatch {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    if (this.invocations === 1) {
      return { output: JSON.stringify({ plan: ["step one", "step two"], notes: "no patch yet" }), adapter: "local-model" };
    }
    const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceNonPatchFenceThenPatch {
  invocations = 0;
  inputs: string[] = [];
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, req: any) {
    this.invocations += 1;
    this.inputs.push(req?.input ?? "");
    if (this.invocations === 1) {
      const output = ["```patch", "console.log('no diff')", "```"].join("\n");
      return { output, adapter: "local-model" };
    }
    const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceJsonPreamblePatch {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- a/tmp.txt",
      "+++ b/tmp.txt",
      "@@",
      "-foo",
      "+hello world",
      "```",
    ].join("\n");
    const payload = { patch };
    const output = `Result:\n${JSON.stringify(payload)}\nDone.`;
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceJsonOnlyPatch {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- a/tmp.txt",
      "+++ b/tmp.txt",
      "@@",
      "-foo",
      "+hello world",
      "```",
    ].join("\n");
    return { output: JSON.stringify({ patch }), adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceJsonFileBlocks {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const payload = {
      files: [{ path: "created.txt", content: "hello from json" }],
    };
    return { output: JSON.stringify(payload), adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceJsonIncidentalFile {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const payload = { path: "created.txt", content: "hello from json" };
    return { output: JSON.stringify(payload), adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceIoWrappedPatch {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const lines = [
      "[agent-io] begin agent=agent-1 adapter=local-model model=stub mode=stream",
      "[agent-io] output ```patch",
      "[agent-io] output --- a/tmp.txt",
      "[agent-io] output +++ b/tmp.txt",
      "[agent-io] output @@",
      "[agent-io] output -foo",
      "[agent-io] output +hello world",
      "[agent-io] output ```",
    ];
    return { output: lines.join("\n"), adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceUnfencedFileBlock {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const output = ["FILE: tmp.txt", "hello world"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServicePlaceholderFileBlock {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const output = ["FILE: tmp.txt", "```", "...", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServicePlaceholderJsonFileBlock {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const payload = {
      files: [{ path: "tmp.txt", content: "rest of existing code" }],
    };
    return { output: JSON.stringify(payload), adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceTestFix {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const fileName = this.invocations === 1 ? "fail.flag" : "pass.flag";
    const content = this.invocations === 1 ? "fail" : "ok";
    const output = [`FILE: ${fileName}`, "```", content, "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceRunAllFix {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const fileName = this.invocations === 1 ? "work.txt" : "global.pass";
    const output = [`FILE: ${fileName}`, "```", "ok", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceRunAllOnce {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const output = ["FILE: global.pass", "```", "ok", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceAlwaysFail {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const output = ["FILE: fail.flag", "```", "fail", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubDocdex {
  async search() {
    return [];
  }
  async close() {}
}

class StubDocdexScopeFail {
  async ensureRepoScope() {
    throw new Error("Docdex repo scope missing for /tmp/ws");
  }
  async search() {
    throw new Error("docdex search should not run without scope");
  }
  async close() {}
}

class StubDocdexWithLinks {
  findByPathCalls: string[] = [];
  fetchByIdCalls: string[] = [];
  async search() {
    return [];
  }
  async findDocumentByPath(docPath: string) {
    this.findByPathCalls.push(docPath);
    if (docPath === "docs/sds/project.md") {
      return {
        id: "doc-1",
        docType: "SDS",
        path: "docs/sds/project.md",
        title: "project.md",
        segments: [{ id: "doc-1-seg-1", docId: "doc-1", index: 0, content: "SDS excerpt" }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return undefined;
  }
  async fetchDocumentById(id: string) {
    this.fetchByIdCalls.push(id);
    return {
      id,
      docType: "DOC",
      title: id,
      segments: [{ id: `${id}-seg-1`, docId: id, index: 0, content: "fallback excerpt" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  async close() {}
}

class StubRepo {
  async getWorkspaceDefaults() {
    return [];
  }
  async close() {}
}

class StubRoutingService {
  async resolveAgentForCommand() {
    return {
      agent: { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any,
      agentId: "agent-1",
      agentSlug: "agent-1",
      model: "stub",
      capabilities: [],
      healthStatus: "healthy",
      source: "override",
      routingPreview: { workspaceId: "ws", commandName: "work-on-tasks" } as any,
    };
  }
}

class StubRatingService {
  calls: any[] = [];
  async rate(request: any) {
    this.calls.push(request);
  }
}

class StubVcs {
  async ensureRepo(_cwd: string) {}
  async isRepo(_cwd?: string) {
    return true;
  }
  async ensureBaseBranch(_cwd: string, _base: string) {}
  async branchExists(_cwd: string, _branch: string) {
    return false;
  }
  async checkoutBranch(_cwd: string, _branch: string) {}
  async createOrCheckoutBranch(_cwd: string, _branch: string, _base: string) {}
  async cherryPick(_cwd: string, _commit: string) {}
  async abortCherryPick(_cwd: string) {}
  async applyPatch(_cwd: string, _patch: string) {}
  async applyPatchWithReject(_cwd: string, _patch: string) {
    return {};
  }
  async pull(_cwd: string, _remote: string, _branch: string, _ffOnly = true) {}
  async conflictPaths(_cwd?: string): Promise<string[]> {
    return [];
  }
  async currentBranch(_cwd?: string) {
    return "mcoda-dev";
  }
  async ensureClean(_cwd: string, _ignoreDotMcoda = true) {}
  async dirtyPaths(_cwd?: string): Promise<string[]> {
    return [];
  }
  async stage(_cwd: string, _paths: string[]) {}
  async status(_cwd?: string) {
    return " M tmp.txt";
  }
  async commit(_cwd: string, _message: string) {}
  async lastCommitSha(_cwd?: string) {
    return "abc123";
  }
  async hasRemote(_cwd?: string) {
    return false;
  }
  async push(_cwd: string, _remote: string, _branch: string) {}
  async merge(_cwd: string, _source: string, _target: string) {}
  async abortMerge(_cwd: string) {}
  async resolveMergeConflicts(
    _cwd: string,
    _strategy: "theirs" | "ours",
    _paths?: string[],
  ): Promise<string[]> {
    return _paths ?? [];
  }
  async resetHard(_cwd: string, _options?: { exclude?: string[] }) {}
}

class DirtyAfterInvokeVcs extends StubVcs {
  dirtyCalls = 0;
  override async dirtyPaths(): Promise<string[]> {
    this.dirtyCalls += 1;
    if (this.dirtyCalls === 1) return [];
    return ["tmp.txt"];
  }
}

class BaseBranchRecordingVcs extends StubVcs {
  bases: string[] = [];
  override async ensureBaseBranch(_cwd: string, base: string) {
    this.bases.push(base);
  }
}

class RecordingVcs extends StubVcs {
  patches: string[] = [];
  override async applyPatch(_cwd: string, patch: string) {
    this.patches.push(patch);
    if (!patch.includes("+hello world")) {
      throw new Error("patch missing content");
    }
  }
  override async status() {
    return "";
  }
}

class CommitTrackingVcs extends StubVcs {
  commitCalls = 0;
  override async commit(_cwd: string, _message: string) {
    this.commitCalls += 1;
  }
}

class RejectRecordingVcs extends StubVcs {
  rejectCalls = 0;
  override async applyPatch(_cwd: string, _patch: string) {
    throw new Error("apply failed");
  }
  override async applyPatchWithReject(_cwd: string, _patch: string) {
    this.rejectCalls += 1;
    return { error: "reject failed" };
  }
}

class RejectWithRejVcs extends RejectRecordingVcs {
  commitCalls = 0;
  override async applyPatchWithReject(cwd: string, patch: string) {
    this.rejectCalls += 1;
    const match = patch.match(/^\+\+\+ b\/(.+)$/m);
    const file = match?.[1]?.trim() || "tmp.txt";
    await fs.writeFile(path.join(cwd, `${file}.rej`), "reject", "utf8");
    return { error: "reject failed" };
  }
  override async commit(_cwd: string, _message: string) {
    this.commitCalls += 1;
  }
}

class ResetTrackingVcs extends RejectRecordingVcs {
  resetCalls: Array<{ cwd: string; options?: { exclude?: string[] } }> = [];
  override async resetHard(cwd: string, options?: { exclude?: string[] }) {
    this.resetCalls.push({ cwd, options });
  }
}

class DirtyBeforeApplyVcs extends RejectRecordingVcs {
  dirtyCalls = 0;
  resetCalls = 0;
  override async dirtyPaths() {
    this.dirtyCalls += 1;
    if (this.dirtyCalls <= 1) return [];
    return ["preexisting.txt"];
  }
  override async resetHard(_cwd: string, _options?: { exclude?: string[] }) {
    this.resetCalls += 1;
  }
}

class DirtyWorkspaceVcs extends StubVcs {
  commitCalls = 0;
  override async dirtyPaths() {
    return ["preexisting.txt"];
  }
  override async commit(_cwd: string, _message: string) {
    this.commitCalls += 1;
  }
}

class MergeRecordingVcs extends StubVcs {
  merges: Array<{ source: string; target: string }> = [];
  checkouts: string[] = [];
  dirtyCalls = 0;
  override async merge(_cwd: string, source: string, target: string) {
    this.merges.push({ source, target });
  }
  override async checkoutBranch(_cwd: string, branch: string) {
    this.checkouts.push(branch);
  }
  override async dirtyPaths() {
    this.dirtyCalls += 1;
    if (this.dirtyCalls <= 4) return [];
    return ["tmp.txt"];
  }
}

class MergeConflictVcs extends StubVcs {
  conflicts: string[] = ["server/src/index.ts"];
  abortCalls = 0;
  resolveCalls = 0;
  resolveStrategy: "theirs" | "ours" | null = null;
  override async branchExists() {
    return true;
  }
  override async merge() {
    throw new Error("merge conflict");
  }
  override async conflictPaths() {
    return this.conflicts;
  }
  override async abortMerge() {
    this.abortCalls += 1;
  }
  override async resolveMergeConflicts(
    _cwd: string,
    strategy: "theirs" | "ours",
    _paths?: string[],
  ): Promise<string[]> {
    this.resolveCalls += 1;
    this.resolveStrategy = strategy;
    return this.conflicts;
  }
}

class PushRecordingVcs extends MergeRecordingVcs {
  pushes: Array<{ remote: string; branch: string }> = [];
  override async hasRemote() {
    return true;
  }
  override async push(_cwd: string, remote: string, branch: string) {
    this.pushes.push({ remote, branch });
  }
}

const setupWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-work-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "proj" });
  const [epic] = await repo.insertEpics(
    [
      {
        projectId: project.id,
        key: "proj-epic",
        title: "Epic",
        description: "",
        priority: 1,
      },
    ],
    false,
  );
  const [story] = await repo.insertStories(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        key: "proj-epic-us-01",
        title: "Story",
        description: "",
      },
    ],
    false,
  );
  const tasks = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task A",
        description: "",
        status: "not_started",
        storyPoints: 1,
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t02",
        title: "Task B",
        description: "",
        status: "not_started",
        storyPoints: 2,
      },
    ],
    false,
  );
  await writeRunAllScript(dir);
  return { dir, workspace, repo, tasks };
};

const cleanupWorkspace = async (dir: string, repo: WorkspaceRepository) => {
  try {
    await repo.close();
  } catch {
    /* ignore */
  }
  await fs.rm(dir, { recursive: true, force: true });
};

const resolveNodeCommand = () => {
  const override = process.env.NODE_BIN?.trim();
  const resolved = override || (process.platform === "win32" ? "node.exe" : "node");
  return resolved.includes(" ") ? `"${resolved}"` : resolved;
};

const writeTestCheckScript = async (dir: string) => {
  const scriptPath = path.join(dir, "test-check.js");
  const contents = [
    "const fs = require(\"node:fs\");",
    "if (!fs.existsSync(\"pass.flag\")) {",
    "  console.error(\"missing pass.flag\");",
    "  process.exit(1);",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, contents, "utf8");
  return `${resolveNodeCommand()} ./test-check.js`;
};

const writeRunAllScript = async (dir: string, contents?: string) => {
  const testsDir = path.join(dir, "tests");
  await fs.mkdir(testsDir, { recursive: true });
  const scriptPath = path.join(testsDir, "all.js");
  const script = contents ?? "process.exit(0);\n";
  await fs.writeFile(scriptPath, script, "utf8");
  return scriptPath;
};

const collectAgentOutput = async (fn: (onChunk: (chunk: string) => void) => Promise<void>): Promise<string> => {
  const chunks: string[] = [];
  await fn((chunk) => chunks.push(chunk));
  return chunks.join("");
};

const writeNoopTestScript = async (dir: string) => {
  const scriptPath = path.join(dir, "unit-test.js");
  const contents = ["process.exit(0);", ""].join("\n");
  await fs.writeFile(scriptPath, contents, "utf8");
  return `${resolveNodeCommand()} ./unit-test.js`;
};

test("workOnTasks marks tasks ready_to_code_review and records task runs", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
    });
    assert.equal(result.results.length, 2);
    const updatedA = await repo.getTaskByKey(tasks[0].key);
    const updatedB = await repo.getTaskByKey(tasks[1].key);
    assert.equal(updatedA?.status, "ready_to_code_review");
    assert.equal(updatedB?.status, "ready_to_code_review");
    const db = repo.getDb();
    const taskRuns = await db.all<{ status: string }[]>("SELECT status FROM task_runs WHERE command = 'work-on-tasks'");
    assert.equal(taskRuns.length, 2);
    assert.ok(taskRuns.every((r) => r.status === "succeeded"));
    const jobs = await db.all<{ state: string }[]>("SELECT state FROM jobs");
    assert.ok(jobs.some((j) => j.state === "completed"));
    const tokens = await db.all<{ tokens_prompt: number }[]>("SELECT tokens_prompt FROM token_usage");
    assert.equal(tokens.length, 2);
    const logs = await db.all<{ source: string }[]>("SELECT source FROM task_logs");
    assert.ok(logs.some((l) => l.source === "agent"));
    assert.ok(logs.some((l) => l.source === "finalize"));
    const commandRunRow = await db.get<{ sp_processed: number | null }>(
      "SELECT sp_processed FROM command_runs WHERE id = ?",
      result.commandRunId,
    );
    assert.equal(commandRunRow?.sp_processed, 3);
    const checkpointPath = path.join(workspace.mcodaDir, "jobs", result.jobId, "work", "state.json");
    const exists = await fs.stat(checkpointPath).then(() => true, () => false);
    assert.equal(exists, true);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks passes adapter override into invocation request", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceCaptureRequest();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      agentAdapterOverride: "codali-cli",
    });
    assert.equal(agentService.lastRequest?.adapterType, "codali-cli");
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks attaches docdex and workspace metadata for agent invocation", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceCaptureRequest();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  const originalBase = process.env.CODALI_DOCDEX_BASE_URL;
  const originalRepoId = process.env.CODALI_DOCDEX_REPO_ID;
  const originalRepoRoot = process.env.CODALI_DOCDEX_REPO_ROOT;
  try {
    process.env.CODALI_DOCDEX_BASE_URL = "http://127.0.0.1:7777";
    process.env.CODALI_DOCDEX_REPO_ID = "repo-123";
    process.env.CODALI_DOCDEX_REPO_ROOT = "/tmp/demo-repo";
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
    });
    const metadata = agentService.lastRequest?.metadata as Record<string, unknown>;
    assert.equal(metadata.command, "work-on-tasks");
    assert.equal(metadata.workspaceRoot, workspace.workspaceRoot);
    assert.equal(metadata.repoRoot, workspace.workspaceRoot);
    assert.equal(metadata.docdexBaseUrl, "http://127.0.0.1:7777");
    assert.equal(metadata.docdexRepoId, "repo-123");
    assert.equal(metadata.docdexRepoRoot, "/tmp/demo-repo");
    assert.equal(metadata.projectKey, "proj");
    assert.equal(metadata.agentId, "agent-1");
    assert.equal(metadata.agentSlug, "agent-1");
  } finally {
    if (originalBase === undefined) {
      delete process.env.CODALI_DOCDEX_BASE_URL;
    } else {
      process.env.CODALI_DOCDEX_BASE_URL = originalBase;
    }
    if (originalRepoId === undefined) {
      delete process.env.CODALI_DOCDEX_REPO_ID;
    } else {
      process.env.CODALI_DOCDEX_REPO_ID = originalRepoId;
    }
    if (originalRepoRoot === undefined) {
      delete process.env.CODALI_DOCDEX_REPO_ROOT;
    } else {
      process.env.CODALI_DOCDEX_REPO_ROOT = originalRepoRoot;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks seeds codali env overrides from gateway handoff", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceCaptureRequest();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  const handoffPath = path.join(dir, "gateway-handoff.md");
  const handoffContent = [
    "# Gateway Handoff",
    "",
    "## Plan",
    "1. Update src/auth/login.ts to include the header.",
    "2. Run the relevant tests.",
    "",
    "## Files Likely Touched",
    "- src/auth/login.ts",
    "- src/auth/helpers.ts",
    "",
    "## Files To Create",
    "- src/auth/new.ts",
    "",
    "## Dirs To Create",
    "- src/auth/utils",
    "",
    "## Risks",
    "- Auth flows may regress.",
  ].join("\n");
  const originalHandoff = process.env[GATEWAY_HANDOFF_ENV_PATH];
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    await fs.writeFile(handoffPath, handoffContent, "utf8");
    process.env[GATEWAY_HANDOFF_ENV_PATH] = handoffPath;
    process.env.MCODA_CLI_STUB = "1";
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      useCodali: true,
      dryRun: false,
      taskKeys: ["proj-epic-us-01-t01"],
    });
    const metadata = agentService.lastRequest?.metadata as Record<string, any>;
    assert.ok(metadata?.codaliEnv);
    const codaliEnv = metadata.codaliEnv as Record<string, string>;
    assert.equal(codaliEnv.CODALI_CONTEXT_SKIP_SEARCH, "1");
    const preferred = (codaliEnv.CODALI_CONTEXT_PREFERRED_FILES ?? "").split(",").filter(Boolean);
    assert.ok(preferred.includes("src/auth/login.ts"));
    assert.ok(preferred.includes("src/auth/new.ts"));
    assert.ok(codaliEnv.CODALI_SECURITY_READONLY_PATHS?.includes("docs/sds"));
    const planHint = JSON.parse(codaliEnv.CODALI_PLAN_HINT ?? "{}");
    assert.deepEqual(planHint.steps, [
      "Update src/auth/login.ts to include the header.",
      "Run the relevant tests.",
    ]);
    assert.ok(planHint.target_files.includes("src/auth/login.ts"));
  } finally {
    if (originalHandoff === undefined) {
      delete process.env[GATEWAY_HANDOFF_ENV_PATH];
    } else {
      process.env[GATEWAY_HANDOFF_ENV_PATH] = originalHandoff;
    }
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips docdex context when gateway handoff is present", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceCaptureRequest();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdexScopeFail() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  const handoffPath = path.join(dir, "gateway-handoff.md");
  const originalHandoff = process.env[GATEWAY_HANDOFF_ENV_PATH];
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    await fs.writeFile(
      handoffPath,
      ["# Gateway Handoff", "", "## Plan", "1. Use gateway plan", "", "## Files Likely Touched", "- src/app.ts"].join(
        "\n",
      ),
      "utf8",
    );
    process.env[GATEWAY_HANDOFF_ENV_PATH] = handoffPath;
    process.env.MCODA_CLI_STUB = "1";
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      useCodali: true,
      dryRun: false,
      taskKeys: ["proj-epic-us-01-t01"],
    });
    assert.ok(result.results.every((r) => r.notes !== "missing_docdex"));
  } finally {
    if (originalHandoff === undefined) {
      delete process.env[GATEWAY_HANDOFF_ENV_PATH];
    } else {
      process.env[GATEWAY_HANDOFF_ENV_PATH] = originalHandoff;
    }
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks streams when codali is required", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceStreamable();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: true,
      useCodali: true,
      dryRun: false,
    });
    assert.ok(agentService.streamCalls > 0);
    assert.equal(agentService.invokeCalls, 0);
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks fails fast when codali CLI is unavailable", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceCaptureRequest();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  const originalBin = process.env.CODALI_BIN;
  const originalStub = process.env.MCODA_CLI_STUB;
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  try {
    process.env.CODALI_BIN = "/__missing__/codali";
    delete process.env.MCODA_CLI_STUB;
    delete process.env.MCODA_SKIP_CLI_CHECKS;
    await assert.rejects(
      service.workOnTasks({
        workspace,
        projectKey: "proj",
        agentStream: false,
        useCodali: true,
        dryRun: false,
      }),
      /codali_unavailable: .*CODALI_BIN/i,
    );
  } finally {
    if (originalBin === undefined) {
      delete process.env.CODALI_BIN;
    } else {
      process.env.CODALI_BIN = originalBin;
    }
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    if (originalSkip === undefined) {
      delete process.env.MCODA_SKIP_CLI_CHECKS;
    } else {
      process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks maps codali provider errors to failure reason", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = {
    async resolveAgent() {
      return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
    },
    async invoke() {
      throw new Error("CODALI_UNSUPPORTED_ADAPTER: gemini-cli");
    },
    async getPrompts() {
      return {
        jobPrompt: "You are a worker.",
        characterPrompt: "Be concise.",
        commandPrompts: { "work-on-tasks": "Apply patches carefully." },
      };
    },
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
    });
    assert.ok(result.results.every((r) => r.notes === "codali_provider_unsupported"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks logs adapter and provider metadata", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
    });
    const db = repo.getDb();
    const row = await db.get<{ details_json: string | null }>(
      "SELECT details_json FROM task_logs WHERE message = 'Adapter context' LIMIT 1",
    );
    assert.ok(row?.details_json);
    const details = JSON.parse(row?.details_json ?? "{}") as Record<string, unknown>;
    assert.equal(details.adapter, "local-model");
    assert.equal(details.provider, "local");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks logs codali artifacts from invocation metadata", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = {
    async resolveAgent() {
      return { id: "agent-1", slug: "agent-1", adapter: "openai-api", defaultModel: "stub" } as any;
    },
    async invoke() {
      const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
      return {
        output: patch,
        adapter: "codali-cli",
        metadata: { logPath: "/tmp/codali.jsonl", touchedFiles: ["tmp.txt"], runId: "run-abc" },
      };
    },
    async getPrompts() {
      return {
        jobPrompt: "You are a worker.",
        characterPrompt: "Be concise.",
        commandPrompts: { "work-on-tasks": "Apply patches carefully." },
      };
    },
  };
  const routingService = {
    async resolveAgentForCommand() {
      return {
        agent: { id: "agent-1", slug: "agent-1", adapter: "openai-api", defaultModel: "stub" } as any,
      };
    },
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: routingService as any,
    vcsClient: new StubVcs() as any,
  });

  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      useCodali: true,
      dryRun: false,
    });
    const db = repo.getDb();
    const row = await db.get<{ details_json: string | null }>(
      "SELECT details_json FROM task_logs WHERE message = 'Codali artifacts captured.' LIMIT 1",
    );
    assert.ok(row?.details_json);
    const details = JSON.parse(row?.details_json ?? "{}") as Record<string, unknown>;
    assert.equal(details.logPath, "/tmp/codali.jsonl");
    assert.deepEqual(details.touchedFiles, ["tmp.txt"]);
    assert.equal(details.runId, "run-abc");
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks includes codali metadata in job summary", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = {
    async resolveAgent() {
      return { id: "agent-1", slug: "agent-1", adapter: "openai-api", defaultModel: "stub" } as any;
    },
    async invoke() {
      const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
      return {
        output: patch,
        adapter: "codali-cli",
        metadata: { logPath: "/tmp/codali.jsonl", touchedFiles: ["tmp.txt"], runId: "run-abc" },
      };
    },
    async getPrompts() {
      return {
        jobPrompt: "You are a worker.",
        characterPrompt: "Be concise.",
        commandPrompts: { "work-on-tasks": "Apply patches carefully." },
      };
    },
  };
  const routingService = {
    async resolveAgentForCommand() {
      return {
        agent: { id: "agent-1", slug: "agent-1", adapter: "openai-api", defaultModel: "stub" } as any,
      };
    },
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: routingService as any,
    vcsClient: new StubVcs() as any,
  });

  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      useCodali: true,
      dryRun: false,
    });
    const job = await jobService.getJob(result.jobId);
    const summary = (job?.payload as any)?.workOnTasks;
    assert.ok(summary);
    assert.equal(summary.useCodali, true);
    assert.equal(summary.agentAdapterOverride, "codali-cli");
    assert.ok(Array.isArray(summary.tasks));
    const withArtifacts = summary.tasks.find((task: any) => task?.codali?.runId === "run-abc");
    assert.ok(withArtifacts);
    assert.equal(withArtifacts.adapter, "openai-api");
    assert.equal(withArtifacts.provider, "openai-compatible");
    assert.equal(withArtifacts.model, "stub");
    assert.equal(withArtifacts.adapterOverride, "codali-cli");
    assert.equal(withArtifacts.codali.logPath, "/tmp/codali.jsonl");
    assert.deepEqual(withArtifacts.codali.touchedFiles, ["tmp.txt"]);
    assert.equal(withArtifacts.codali.runId, "run-abc");
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks uses codali adapter path with stubbed CLI", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceCodaliAdapter();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new DirtyAfterInvokeVcs() as any,
  });

  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      useCodali: true,
      agentStream: false,
      dryRun: false,
    });
    assert.equal(agentService.lastRequest?.adapterType, "codali-cli");
    assert.ok(result.results.every((r) => r.status === "succeeded"));
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks ignores patch mode when codali is required", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceCodaliAdapter();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new DirtyAfterInvokeVcs() as any,
  });

  const originalStub = process.env.MCODA_CLI_STUB;
  const originalPatchMode = process.env.MCODA_WORK_ON_TASKS_PATCH_MODE;
  try {
    process.env.MCODA_CLI_STUB = "1";
    process.env.MCODA_WORK_ON_TASKS_PATCH_MODE = "1";
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      useCodali: true,
      agentStream: false,
      dryRun: false,
    });
    assert.ok(
      result.warnings.some((warning) =>
        warning.includes("work-on-tasks patch mode is ignored when codali is required."),
      ),
    );
    assert.ok(result.results.every((r) => r.status === "succeeded"));
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    if (originalPatchMode === undefined) {
      delete process.env.MCODA_WORK_ON_TASKS_PATCH_MODE;
    } else {
      process.env.MCODA_WORK_ON_TASKS_PATCH_MODE = originalPatchMode;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks patches outside workspace", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceOutOfScopePatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "scope_violation");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "failed");
    assert.equal((updated?.metadata as any)?.failed_reason, "scope_violation");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks merges task branch even when task fails", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new MergeRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceOutOfScopePatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(vcs.merges.length, 1);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks invokes agent rating when enabled", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const ratingService = new StubRatingService();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
    ratingService: ratingService as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      rateAgents: true,
    });
    assert.equal(result.results.length, 2);
    assert.equal(ratingService.calls.length, 2);
    const ratedKeys = ratingService.calls.map((call) => call.taskKey).sort();
    assert.deepEqual(ratedKeys, tasks.map((task) => task.key).sort());
    assert.ok(ratingService.calls.every((call) => call.commandName === "work-on-tasks"));
    assert.ok(ratingService.calls.every((call) => call.agentId === "agent-1"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks handles apply_patch add-file output without leading '+' lines", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoPlus() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((p) => p.includes("+hello world")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks accepts bullet FILE blocks with backticked paths", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceBulletFile() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    const contents = await fs.readFile(path.join(dir, "bullet.txt"), "utf8");
    assert.equal(contents, "bullet content");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks parses JSON patches when output is JSON-only", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceJsonOnlyPatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((patch) => patch.includes("+hello world")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks applies JSON file blocks from explicit files container", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceJsonFileBlocks() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    const written = await fs.readFile(path.join(workspace.workspaceRoot, "created.txt"), "utf8");
    assert.equal(written, "hello from json");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks rejects incidental JSON file entries without explicit container", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceJsonIncidentalFile();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "missing_patch");
    assert.equal(agentService.invocations, 2);
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "in_progress");
    assert.equal((updated?.metadata as any)?.blocked_reason, undefined);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks strips agent-io markers before parsing patches", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceIoWrappedPatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((patch) => patch.includes("+hello world")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks rejects unfenced FILE blocks", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServiceUnfencedFileBlock();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "missing_patch");
    assert.equal(agentService.invocations, 2);
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "in_progress");
    assert.equal((updated?.metadata as any)?.blocked_reason, undefined);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks rejects placeholder FILE blocks", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServicePlaceholderFileBlock();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "missing_patch");
    assert.equal(agentService.invocations, 2);
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "in_progress");
    assert.equal((updated?.metadata as any)?.blocked_reason, undefined);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks rejects placeholder JSON file blocks", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agentService = new StubAgentServicePlaceholderJsonFileBlock();
  const service = new WorkOnTasksService(workspace, {
    agentService: agentService as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "missing_patch");
    assert.equal(agentService.invocations, 2);
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "in_progress");
    assert.equal((updated?.metadata as any)?.blocked_reason, undefined);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks rejects JSON patches with surrounding text", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceJsonPreamblePatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "missing_patch");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "in_progress");
    assert.equal((updated?.metadata as any)?.blocked_reason, undefined);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks logs docdex scope failures before search", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdexScopeFail() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
      noCommit: true,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "missing_docdex");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "failed");
    assert.equal((updated?.metadata as any)?.failed_reason, "missing_docdex");
    const logs = await repo.getDb().all<{ source: string; message: string }[]>(
      "SELECT source, message FROM task_logs",
    );
    assert.ok(logs.some((log) => log.source === "docdex" && log.message.includes("docdex scope missing")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks normalizes absolute patch paths into workspace-relative paths", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceAbsolutePatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((patch) => patch.includes("+++ b/tests/absolute.txt")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks converts add patches for missing files into new-file patches", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceAddPatchMissingFile() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((patch) => patch.includes("--- /dev/null")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks persists patch artifacts when apply fails", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RejectRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "patch_failed");
    assert.ok(vcs.rejectCalls >= 1);

    const patchDir = path.join(workspace.mcodaDir, "jobs", result.jobId, "work", "patches");
    const entries = await fs.readdir(patchDir);
    assert.ok(entries.length > 0);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks on patch rejects and cleans .rej artifacts", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RejectWithRejVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    await fs.writeFile(path.join(dir, "tmp.txt"), "baz", "utf8");
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "patch_failed");
    assert.ok(vcs.rejectCalls >= 1);

    const rejPath = path.join(dir, "tmp.txt.rej");
    const rejExists = await fs
      .access(rejPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(rejExists, false);

    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const rejectComment = comments.find((comment) => comment.category === "patch_reject");
    assert.ok(rejectComment?.body.includes("Patch rejected"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks destructive doc edits without allow flag", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceLargeDocDeletion() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const docsDir = path.join(dir, "docs", "sds");
    await fs.mkdir(docsDir, { recursive: true });
    const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
    await fs.writeFile(path.join(docsDir, "guard.md"), content, "utf8");
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "doc_edit_guard");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "failed");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const guardComment = comments.find((comment) => comment.category === "doc_edit_guard");
    assert.ok(guardComment?.body.includes("allow_doc_edits"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks allows doc edits when metadata allows", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  await repo.updateTask(tasks[0].id, { metadata: { allow_doc_edits: true } });
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceLargeDocDeletion() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const docsDir = path.join(dir, "docs", "sds");
    await fs.mkdir(docsDir, { recursive: true });
    const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
    await fs.writeFile(path.join(docsDir, "guard.md"), content, "utf8");
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const guardComment = comments.find((comment) => comment.category === "doc_edit_guard");
    assert.equal(Boolean(guardComment), false);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks prepends project guidance to agent input", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const guidanceDir = path.join(dir, "docs");
  await fs.mkdir(guidanceDir, { recursive: true });
  const guidancePath = path.join(guidanceDir, "project-guidance.md");
  await fs.writeFile(guidancePath, "GUIDANCE BLOCK", "utf8");
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.ok(agent.lastInput);
    const input = agent.lastInput ?? "";
    const guidanceIndex = input.indexOf("GUIDANCE BLOCK");
    const taskIndex = input.indexOf("Task proj-epic-us-01-t01");
    assert.ok(guidanceIndex >= 0);
    assert.ok(taskIndex > guidanceIndex);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks prompt omits plan instruction in favor of patch-only output", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(!input.includes("Provide a concise plan"));
    assert.ok(input.includes("Output requirements:"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks strips gateway-style prompts from agent profile", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  let lastInput = "";
  const agent = {
    resolveAgent: async () => ({ id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any),
    invoke: async (_id: string, { input }: { input: string }) => {
      lastInput = input;
      const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
      return { output: patch, adapter: "local-model" };
    },
    getPrompts: async () => ({
      jobPrompt: "You are the gateway agent. Return JSON only.",
      characterPrompt: "Do not include fields outside the schema.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    }),
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.ok(!lastInput.toLowerCase().includes("gateway agent"));
    assert.ok(!lastInput.toLowerCase().includes("return json only"));
    assert.ok(lastInput.includes("Apply patches carefully."));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks resolves docdex path links via findDocumentByPath", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  await repo.updateTask(tasks[0].id, {
    metadata: { doc_links: ["docdex:docs/sds/project.md"] },
  });
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const docdex = new StubDocdexWithLinks();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: docdex as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(docdex.findByPathCalls.includes("docs/sds/project.md"));
    assert.ok(input.includes("[linked:SDS]"));
    assert.ok(input.includes("SDS excerpt"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks downgrades SDS doc types outside docs/sds in doc context", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  await repo.updateTask(tasks[0].id, {
    metadata: { doc_links: ["docdex:docs/architecture.md"] },
  });
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const now = new Date().toISOString();
  const docdex = {
    search: async () => [
      {
        id: "doc-arch",
        docType: "SDS",
        path: "docs/architecture.md",
        title: "Architecture",
        segments: [{ id: "doc-arch-seg-1", docId: "doc-arch", index: 0, content: "Architecture excerpt" }],
        createdAt: now,
        updatedAt: now,
      },
    ],
    findDocumentByPath: async () => ({
      id: "doc-arch-link",
      docType: "SDS",
      path: "docs/architecture.md",
      title: "Architecture",
      segments: [{ id: "doc-arch-link-seg-1", docId: "doc-arch-link", index: 0, content: "Link excerpt" }],
      createdAt: now,
      updatedAt: now,
    }),
    fetchDocumentById: async (id: string) => ({
      id,
      docType: "DOC",
      title: id,
      createdAt: now,
      updatedAt: now,
    }),
    close: async () => {},
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: docdex as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(input.includes("[DOC] Architecture"));
    assert.ok(input.includes("[linked:DOC] Architecture"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks filters QA and .mcoda docs from doc context", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const docdex = {
    search: async () => [
      {
        id: "doc-qa",
        docType: "DOC",
        path: "docs/qa-workflow.md",
        title: "QA Workflow",
        createdAt: "now",
        updatedAt: "now",
      },
      {
        id: "doc-e2e",
        docType: "DOC",
        path: "docs/e2e-test-issues.md",
        title: "E2E Issues",
        createdAt: "now",
        updatedAt: "now",
      },
      {
        id: "doc-hidden",
        docType: "DOC",
        path: ".mcoda/docs/internal.md",
        title: "Internal Guidance",
        createdAt: "now",
        updatedAt: "now",
      },
      {
        id: "doc-sds",
        docType: "SDS",
        path: "docs/sds/project.md",
        title: "Project SDS",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
    close: async () => {},
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: docdex as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(input.includes("Project SDS"));
    assert.ok(!input.includes("QA Workflow"));
    assert.ok(!input.includes("E2E Issues"));
    assert.ok(!input.includes("Internal Guidance"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks includes unresolved review + QA comment backlog", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  const now = new Date().toISOString();
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-1",
    status: "open",
    file: "src/app.ts",
    line: 12,
    body: "Fix null guard in handler",
    metadata: { suggestedFix: "Add early return when value missing" },
    createdAt: now,
  });
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-1",
    status: "open",
    file: "src/app.ts",
    line: 12,
    body: "Duplicate of review-1",
    createdAt: now,
  });
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "qa-tasks",
    authorType: "agent",
    slug: "qa-1",
    status: "open",
    file: "tests/ui.spec.ts",
    line: 5,
    body: "Fix flaky UI assertion",
    createdAt: now,
  });
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "work-on-tasks",
    authorType: "agent",
    slug: "work-1",
    status: "open",
    body: "Internal work note",
    createdAt: now,
  });
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "resolved-1",
    status: "resolved",
    body: "Resolved note",
    resolvedAt: new Date().toISOString(),
    resolvedBy: "agent-1",
    createdAt: now,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(input.includes("Comment backlog"));
    assert.ok(input.includes("review-1"));
    assert.ok(input.includes("qa-1"));
    assert.ok(input.includes("Work log (recent):"));
    assert.ok(input.includes("work-1"));
    assert.ok(!input.includes("resolved-1"));
    assert.equal((input.match(/review-1/g) ?? []).length, 1);
    assert.ok(input.includes("src/app.ts:12"));
    assert.ok(input.includes("tests/ui.spec.ts:5"));
    assert.ok(input.includes("Suggested fix: Add early return when value missing"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks logs comment progress when unresolved comments exist", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "tmp.txt"), "foo", "utf8");
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-open",
    status: "open",
    body: "Fix missing guard",
    createdAt: new Date().toISOString(),
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "succeeded");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    assert.ok(comments.some((comment) => comment.category === "comment_progress"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks applies comment resolutions from JSON output", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceCommentResolution() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "tmp.txt"), "foo", "utf8");
  const now = new Date().toISOString();
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-open",
    status: "open",
    body: "Open review comment",
    createdAt: now,
  });
  const resolvedAt = new Date(Date.now() - 1000).toISOString();
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-resolved",
    status: "resolved",
    body: "Resolved review comment",
    createdAt: resolvedAt,
    resolvedAt,
    resolvedBy: "agent-0",
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "succeeded");

    const resolved = await repo.listTaskComments(tasks[0].id, { slug: "review-open", resolved: true });
    assert.ok(resolved.length > 0);

    const reopened = await repo.listTaskComments(tasks[0].id, { slug: "review-resolved", resolved: false });
    assert.ok(reopened.length > 0);

    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    assert.ok(comments.some((comment) => comment.category === "comment_resolution"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks fails no-change runs when comment backlog remains unresolved", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChangeCommentResolution() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "existing.txt"), "keep", "utf8");
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-open",
    status: "open",
    body: "Open review comment",
    createdAt: new Date().toISOString(),
  });

  const originalEnforce = process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG;
  try {
    process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG = "1";
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "comment_backlog_unaddressed");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "changes_requested");
    const resolved = await repo.listTaskComments(tasks[0].id, { slug: "review-open", resolved: true });
    assert.equal(resolved.length, 0);
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    assert.ok(comments.some((comment) => comment.category === "comment_backlog"));
  } finally {
    if (originalEnforce === undefined) {
      delete process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG;
    } else {
      process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG = originalEnforce;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks when agent reports missing comment backlog", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceBacklogMissing() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "tmp.txt"), "foo", "utf8");
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-open",
    status: "open",
    body: "Open review comment",
    createdAt: new Date().toISOString(),
  });

  const originalEnforce = process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG;
  try {
    process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG = "1";
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "comment_backlog_missing");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "failed");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const backlog = comments.find((comment) => comment.category === "comment_backlog");
    assert.ok(backlog?.body.includes("Open comment slugs: review-open"));
  } finally {
    if (originalEnforce === undefined) {
      delete process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG;
    } else {
      process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG = originalEnforce;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks fails no-change runs when unresolved comments exist", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "existing.txt"), "keep", "utf8");
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-1",
    status: "open",
    body: "Fix missing guard",
    createdAt: new Date().toISOString(),
  });

  const originalEnforce = process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG;
  try {
    process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG = "1";
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "comment_backlog_unaddressed");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "changes_requested");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const backlog = comments.find((comment) => comment.category === "comment_backlog");
    assert.ok(backlog?.body.includes("Open comment slugs: review-1"));
    assert.ok(backlog?.body.includes("Justification:"));
    assert.ok((backlog?.metadata as any)?.justification);
    assert.equal((backlog?.metadata as any)?.reason, "comment_backlog_unaddressed");
  } finally {
    if (originalEnforce === undefined) {
      delete process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG;
    } else {
      process.env.MCODA_WOT_ENFORCE_COMMENT_BACKLOG = originalEnforce;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks ignores workspace config base branch and uses mcoda-dev", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  workspace.config = { ...(workspace.config ?? {}), branch: "main" };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new BaseBranchRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: true,
      noCommit: true,
      limit: 1,
    });
    assert.ok(vcs.bases.includes("mcoda-dev"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks defaults base branch to mcoda-dev when config missing", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  workspace.config = { ...(workspace.config ?? {}), branch: undefined };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new BaseBranchRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: true,
      noCommit: true,
      limit: 1,
    });
    assert.ok(vcs.bases.includes("mcoda-dev"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks completes no-change runs without unresolved comments", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "existing.txt"), "keep", "utf8");

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "succeeded");
    assert.equal(result.results[0]?.notes, "no_changes");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "ready_to_code_review");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const noChange = comments.find((comment) => comment.category === "no_changes");
    assert.ok(noChange?.body.includes("No changes were required"));
    assert.ok(noChange?.body.includes("Justification:"));
    assert.equal((noChange?.metadata as any)?.reason, "no_changes_completed");
    assert.ok((noChange?.metadata as any)?.justification);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks overwrites existing files from FILE blocks in fallback mode", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RejectRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceFallbackFileOverwrite() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });
  const targetPath = path.join(dir, "existing.txt");
  await fs.writeFile(targetPath, "before", "utf8");

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      allowFileOverwrite: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "succeeded");
    const updated = await fs.readFile(targetPath, "utf8");
    assert.equal(updated.trim(), "fallback overwrite");
    const logs = await repo.getDb().all<{ message: string }[]>("SELECT message FROM task_logs");
    assert.ok(logs.some((log) => log.message.includes("Overwriting existing file")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks rejects patch fallback responses that are not FILE-only", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceFallbackInvalid();
  const vcs = new RejectRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });
  await fs.writeFile(path.join(dir, "existing.txt"), "before", "utf8");

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      allowFileOverwrite: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "patch_failed");
    assert.equal(agent.invocations, 2);
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "failed");
    assert.equal((updated?.metadata as any)?.failed_reason, "patch_failed");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks strips diff prefixes from FILE block paths", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceFileBlockDiffPrefix() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "succeeded");
    const created = await fs.readFile(path.join(dir, "dir", "new.txt"), "utf8");
    assert.equal(created.trim(), "prefixed content");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks rejects FILE block paths with diff metadata suffixes", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceFileBlockWithMetadata();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "missing_patch");
    assert.equal(agent.invocations, 2);
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "in_progress");
    assert.equal((updated?.metadata as any)?.blocked_reason, undefined);
    const exists = await fs
      .stat(path.join(dir, "new.txt"))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks allows no-change runs for in_progress status", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "existing.txt"), "keep", "utf8");
  await repo.updateTask(tasks[0].id, { status: "in_progress" });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      statusFilter: ["in_progress"],
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "succeeded");
    assert.equal(result.results[0]?.notes, "no_changes");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "ready_to_code_review");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const noChange = comments.find((comment) => comment.category === "no_changes");
    assert.ok(noChange?.body.includes("Justification:"));
    assert.equal((noChange?.metadata as any)?.reason, "no_changes_completed");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips qa_followup tasks during auto selection", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  const [qaFollowup] = await repo.insertTasks(
    [
      {
        projectId: tasks[0].projectId,
        epicId: tasks[0].epicId,
        userStoryId: tasks[0].userStoryId,
        key: "proj-epic-us-01-t99",
        title: "QA follow-up task",
        description: "",
        status: "not_started",
        type: "qa_followup",
        priority: 1,
        storyPoints: 1,
      },
    ],
    false,
  );

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.selection.ordered.length, 1);
    assert.notEqual(result.selection.ordered[0]?.task.key, qaFollowup.key);
    const qaTask = await repo.getTaskByKey(qaFollowup.key);
    assert.equal(qaTask?.status, "not_started");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks ignores dependency readiness during selection", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await repo.updateTask(tasks[1].id, { status: "failed" });
  await repo.insertTaskDependencies(
    [
      {
        taskId: tasks[0].id,
        dependsOnTaskId: tasks[1].id,
        relationType: "blocks",
      },
    ],
    false,
  );

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.selection.ordered[0]?.task.key, tasks[0].key);
    assert.ok(!result.selection.warnings.some((warning) => warning.includes("dependencies not ready")));
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "ready_to_code_review");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks retries when agent returns json-only output", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceJsonPlanThenPatch();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(agent.invocations >= 2);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks retries when patch fence lacks diff markers", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceNonPatchFenceThenPatch();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.equal(agent.invocations, 2);
    assert.ok(agent.inputs[1]?.includes("Output ONLY code changes."));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks retries failing tests until they pass", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceTestFix();
  const testCommand = await writeTestCheckScript(dir);
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: [testCommand],
      test_requirements: {
        unit: ["pass.flag exists"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.ok(agent.invocations >= 2);
    assert.equal(result.results[0]?.status, "succeeded");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "ready_to_code_review");
    const passExists = await fs.stat(path.join(dir, "pass.flag")).then(
      () => true,
      () => false,
    );
    assert.equal(passExists, true);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks applies chromium env for browser test commands", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  const chromiumPath = path.join(dir, "bin", "chromium");
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  await fs.writeFile(chromiumPath, "", "utf8");
  process.env.MCODA_QA_CHROMIUM_PATH = chromiumPath;

  try {
    const result = await (service as any).applyChromiumForTests(["npx cypress run"]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.commands, ["npx cypress run --browser chromium"]);
    assert.equal(result.env.CHROME_PATH, chromiumPath);
    assert.equal(result.env.CHROME_BIN, chromiumPath);
    assert.equal(result.env.PUPPETEER_EXECUTABLE_PATH, chromiumPath);
    assert.equal(result.env.PUPPETEER_PRODUCT, "chrome");
    assert.equal(result.env.CYPRESS_BROWSER, "chromium");
  } finally {
    if (prevChromiumPath === undefined) {
      delete process.env.MCODA_QA_CHROMIUM_PATH;
    } else {
      process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
    }
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks creates run-all tests script when missing", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const testCommand = await writeNoopTestScript(dir);
  await fs.rm(path.join(dir, "tests", "all.js"), { force: true });
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: [testCommand],
      test_requirements: {
        unit: ["unit-test.js"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");

    const scriptPath = path.join(dir, "tests", "all.js");
    const exists = await fs.stat(scriptPath).then(
      () => true,
      () => false,
    );
    assert.equal(exists, true);
    const contents = await fs.readFile(scriptPath, "utf8");
    assert.ok(contents.includes("unit-test.js"));
    assert.ok(contents.includes("require(\"node:child_process\")"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks uses category test commands when requirements are set", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  await fs.writeFile(path.join(dir, "test-pass.js"), "process.exit(0);\n", "utf8");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "app",
        version: "1.0.0",
        scripts: { "test:unit": "node ./test-pass.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  await repo.updateTask(tasks[0].id, {
    metadata: {
      test_requirements: {
        unit: ["unit tests"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");

    const updated = await repo.getTaskByKey(tasks[0].key);
    const testCommands = (updated?.metadata as any)?.test_commands ?? [];
    assert.ok(testCommands.some((command: string) => command.includes("npm run test:unit")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks fails when tests are required but no commands exist", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  await fs.rm(path.join(dir, "tests", "all.js"), { force: true });
  await repo.updateTask(tasks[0].id, {
    metadata: {
      test_requirements: {
        unit: ["missing test commands"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "tests_not_configured");

    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "failed");
    assert.equal((updated?.metadata as any)?.failed_reason, "tests_not_configured");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks retries when run-all tests fail", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceRunAllFix();
  await writeRunAllScript(
    dir,
    [
      "const fs = require(\"node:fs\");",
      "if (!fs.existsSync(\"global.pass\")) {",
      "  console.error(\"missing global.pass\");",
      "  process.exit(1);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await repo.updateTask(tasks[0].id, {
    metadata: {
      test_requirements: {
        unit: ["run all tests"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.ok(agent.invocations >= 2);
    assert.equal(result.results[0]?.status, "succeeded");
    const globalPassExists = await fs.stat(path.join(dir, "global.pass")).then(
      () => true,
      () => false,
    );
    assert.equal(globalPassExists, true);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips package-manager test commands when no package.json", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceRunAllOnce();
  await writeRunAllScript(
    dir,
    [
      "const fs = require(\"node:fs\");",
      "if (!fs.existsSync(\"global.pass\")) {",
      "  console.error(\"missing global.pass\");",
      "  process.exit(1);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: ["npm test"],
      test_requirements: {
        unit: ["password utility tests"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.equal(agent.invocations, 1);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks tasks when tests keep failing", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceAlwaysFail();
  const vcs = new CommitTrackingVcs();
  const testCommand = await writeTestCheckScript(dir);
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: [testCommand],
      test_requirements: {
        unit: ["pass.flag exists"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.ok(agent.invocations > 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "tests_failed");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "failed");
    assert.equal((updated?.metadata as any)?.failed_reason, "tests_failed");
    assert.ok(vcs.commitCalls >= 1);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks auto-resolves merge conflicts by taking latest (theirs)", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new MergeConflictVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "ready_to_code_review");
    assert.equal(vcs.abortCalls, 0);
    assert.ok(vcs.resolveCalls >= 1);
    assert.equal(vcs.resolveStrategy, "theirs");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks merges even when file scope missing and config enabled", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  workspace.config = { restrictAutoMergeWithoutScope: true };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  await repo.updateTask(tasks[0].id, { metadata: {} });
  const vcs = new MergeRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.equal(vcs.merges.length, 1);
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "ready_to_code_review");
    const db = repo.getDb();
    const logs = await db.all<{ message: string | null }[]>("SELECT message FROM task_logs WHERE source = 'vcs'");
    assert.ok(logs.some((log) => (log.message ?? "").includes("Auto-merge setting ignored (no_file_scope)")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks merges even when autoMerge disabled", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  workspace.config = { autoMerge: false };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new MergeRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const output = await collectAgentOutput(async (onChunk) => {
      const result = await service.workOnTasks({
        workspace,
        projectKey: "proj",
        agentStream: false,
        dryRun: false,
        limit: 1,
        onAgentChunk: onChunk,
      });
      assert.equal(result.results.length, 1);
    });
    assert.equal(vcs.merges.length, 1);
    const db = repo.getDb();
    const logs = await db.all<{ message: string | null }[]>("SELECT message FROM task_logs WHERE source = 'vcs'");
    assert.ok(logs.some((log) => (log.message ?? "").includes("Auto-merge setting ignored (auto_merge_disabled)")));
    assert.ok(output.includes("Merge→mcoda-dev:   merged"));
    assert.ok(output.includes("auto_merge_disabled_forced"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks end summary includes failure reason", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceOutOfScopePatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const output = await collectAgentOutput(async (onChunk) => {
      const result = await service.workOnTasks({
        workspace,
        projectKey: "proj",
        agentStream: false,
        dryRun: false,
        limit: 1,
        onAgentChunk: onChunk,
      });
      assert.equal(result.results[0]?.status, "failed");
    });
    assert.ok(output.includes("Failure:"));
    assert.ok(output.includes("scope_violation"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks pushes even when autoPush disabled", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  workspace.config = { autoPush: false };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new PushRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(vcs.pushes.length, 2);
    const db = repo.getDb();
    const logs = await db.all<{ message: string | null }[]>("SELECT message FROM task_logs WHERE source = 'vcs'");
    assert.ok(logs.some((log) => (log.message ?? "").includes("Auto-push setting ignored")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks rolls back workspace after patch apply failure", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceFallbackInvalid();
  const vcs = new ResetTrackingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(vcs.resetCalls.length, 1);
    assert.ok(vcs.resetCalls[0]?.options?.exclude?.includes(".mcoda"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips rollback when workspace is dirty before apply", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceFallbackInvalid();
  const vcs = new DirtyBeforeApplyVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(vcs.resetCalls, 0);
    const logs = await repo.getDb().all<{ message: string }[]>("SELECT message FROM task_logs");
    assert.ok(logs.some((log) => log.message.includes("Skipped workspace rollback")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks auto-commits when workspace is dirty before checkout", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new DirtyWorkspaceVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.ok(vcs.commitCalls > 0);
    const logs = await repo.getDb().all<{ message: string }[]>("SELECT message FROM task_logs");
    assert.ok(logs.some((log) => log.message.includes("Auto-committed pending changes")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips package-manager test commands when test script missing", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceRunAllOnce();
  await writeRunAllScript(
    dir,
    [
      "const fs = require(\"node:fs\");",
      "if (!fs.existsSync(\"global.pass\")) {",
      "  console.error(\"missing global.pass\");",
      "  process.exit(1);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", scripts: { lint: "echo lint" } }, null, 2),
    "utf8",
  );
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: ["npm test"],
      test_requirements: {
        unit: ["password utility tests"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    const logs = await repo.getDb().all<{ message: string }[]>("SELECT message FROM task_logs");
    assert.ok(logs.some((log) => log.message.includes("test script missing")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips tests when no requirements and no commands are provided", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  await fs.rm(path.join(dir, "tests", "all.js"), { force: true });
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "succeeded");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks emits start/end markers even when tasks fail", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceFallbackInvalid();
  const vcs = new RejectRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });
  const output = await collectAgentOutput(async (onChunk) => {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
      onAgentChunk: onChunk,
    });
  });

  try {
    assert.ok(output.includes("START OF WORK TASK"));
    assert.ok(output.includes("END OF WORK TASK"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});
