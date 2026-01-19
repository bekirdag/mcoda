import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GATEWAY_HANDOFF_ENV_PATH,
  buildGatewayHandoffDocdexUsage,
  buildGatewayHandoffContent,
  withGatewayHandoff,
  writeGatewayHandoffFile,
} from "../GatewayHandoff.js";

const sampleResult = {
  commandRunId: "run-1",
  job: "work-on-tasks",
  gatewayAgent: { id: "gw-1", slug: "gateway" },
  tasks: [],
  docdex: [],
  analysis: {
    summary: "Summary",
    reasoningSummary: "Reason",
    currentState: "Current",
    todo: "Todo",
    understanding: "Understanding",
    plan: ["Step 1"],
    complexity: 3,
    discipline: "backend",
    filesLikelyTouched: ["src/file.ts"],
    filesToCreate: ["src/new.ts"],
    assumptions: ["Assume"],
    risks: ["Risk"],
    docdexNotes: ["Docdex note"],
  },
  chosenAgent: { agentId: "agent-1", agentSlug: "agent-1", rationale: "Fit" },
  warnings: [],
};

test("buildGatewayHandoffContent renders core sections", () => {
  const content = buildGatewayHandoffContent(sampleResult as any);
  assert.ok(content.includes("# Gateway Handoff"));
  assert.ok(content.includes("## Summary"));
  assert.ok(content.includes("## Current State"));
  assert.ok(content.includes("## Todo"));
  assert.ok(content.includes("## Plan"));
  assert.ok(content.includes("## Files Likely Touched"));
  assert.ok(content.includes("- src/file.ts"));
  assert.ok(content.includes("## Files To Create"));
  assert.ok(content.includes("- src/new.ts"));
});

test("buildGatewayHandoffDocdexUsage uses unified guidance", () => {
  const guidance = buildGatewayHandoffDocdexUsage();
  assert.ok(guidance.includes("Docdex context is injected by mcoda; do not run docdexd directly."));
  assert.ok(guidance.includes("--repo <workspaceRoot>"));
  assert.ok(guidance.includes("DOCDEX_REPO=<workspaceRoot>"));
});

test("buildGatewayHandoffContent includes docdex guidance once", () => {
  const content = buildGatewayHandoffContent(sampleResult as any);
  const marker = "Docdex context is injected by mcoda; do not run docdexd directly.";
  assert.equal(content.split(marker).length - 1, 1);
});

test("writeGatewayHandoffFile writes content and returns path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-handoff-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-handoff-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    const handoffPath = await writeGatewayHandoffFile(dir, "run-1", "content");
    const onDisk = await fs.readFile(handoffPath, "utf8");
    assert.equal(onDisk, "content");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("withGatewayHandoff sets and restores env var", async () => {
  const prev = process.env[GATEWAY_HANDOFF_ENV_PATH];
  process.env[GATEWAY_HANDOFF_ENV_PATH] = "prev";
  await withGatewayHandoff("next", async () => {
    assert.equal(process.env[GATEWAY_HANDOFF_ENV_PATH], "next");
  });
  assert.equal(process.env[GATEWAY_HANDOFF_ENV_PATH], "prev");
  if (prev === undefined) {
    delete process.env[GATEWAY_HANDOFF_ENV_PATH];
  } else {
    process.env[GATEWAY_HANDOFF_ENV_PATH] = prev;
  }
});
