import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../tools/shell/AsyncProcess.js";
import { ToolExecutionError } from "../../tools/ToolTypes.js";

test("terminal goals survive five compactions, two process restarts, bad helper context and user steering", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-long-journey-v1-"));
  const workspace = path.join(root, "workspace"); const state = path.join(root, "state");
  await fs.mkdir(workspace); await fs.mkdir(state);
  await fs.writeFile(path.join(workspace, "USER_NOTES.md"), "Pre-existing user work.\n");
  const fixture = fileURLToPath(new URL("../fixtures/TerminalRecoveryJourney.js", import.meta.url));
  try {
    for (const stage of [1, 2, 3]) {
      if (stage === 2) await fs.appendFile(path.join(workspace, "USER_NOTES.md"), "A concurrent user correction must survive.\n");
      const started = performance.now();
      try {
        // This is a durability/recovery test with many synced state writes, not a
        // latency benchmark. Allow loaded CI disks while retaining a hard bound.
        await runProcess(process.execPath, [fixture, workspace, state, String(stage)], { workspaceRoot: workspace, shellTimeoutMs: 120000 });
      } catch (error) {
        const details = error instanceof ToolExecutionError ? error.details : undefined;
        throw Object.assign(new Error(`Recovery stage ${stage} failed after ${Math.round(performance.now() - started)}ms: ${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(details ?? {})}`), { cause: error });
      }
      t.diagnostic(`Recovery stage ${stage} completed in ${Math.round(performance.now() - started)}ms`);
      const handoff = JSON.parse(await fs.readFile(path.join(state, "journey.json"), "utf8"));
      assert.equal(handoff.stage, stage); assert.equal(handoff.requirements, stage === 1 ? 12 : 13); assert.equal(handoff.completed, stage === 3);
      if (stage === 3) { assert.equal(handoff.compactions, 5); assert.equal(handoff.goalRevision, 2); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
