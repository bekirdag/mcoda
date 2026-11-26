import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractReviewFixture } from "../../eval/fixtures/ContractReviewProvider.js";
import { SessionController } from "../SessionController.js";
import type { Provider, ProviderResponse } from "../../providers/ProviderTypes.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

const config: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } }, models: { model: { provider: "local", catalogId: "test", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } }, bindings: { lead: { candidates: ["model"] }, reviewer: { useBinding: "lead" } } };
const resolved = { config, hash: orchestrationHash(config), source: "test" };
const reply = (content: string): ProviderResponse => ({ message: { role: "assistant", content }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
const call = (name: string, args: unknown): ProviderResponse => ({ ...reply(""), toolCalls: [{ id: `${name}-${Math.random()}`, name, args }] });

/** Edits `target` from outside the sandbox once the running command has written `marker`. */
const editWhenStarted = (root: string, marker: string, target: string, content: string): Promise<void> => (async () => {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path.join(root, marker))) {
    if (Date.now() > deadline) throw new Error(`Command never wrote ${marker}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await fs.writeFile(path.join(root, target), content);
})();

/** A command that announces it started, then waits until `watched` changes (bounded). */
const waitForChange = (marker: string, watched: string) => `const fs=require('fs');const read=()=>{try{return fs.readFileSync(${JSON.stringify(watched)},'utf8')}catch{return ''}};const before=read();fs.writeFileSync(${JSON.stringify(marker)},'1');const t=Date.now();while(Date.now()-t<15000&&read()===before){}console.log('watched file changed')`;

test("a workspace conflict found after a shell call fails only that call, and the session goes on", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-conflict-call-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-conflict-call-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "out"));
  await fs.writeFile(path.join(root, "src", "ledger.py"), "def balance():\n    return 0\n");
  let step = 0; const pending: Promise<void>[] = []; const seen: string[] = [];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    const contract = contractReviewFixture(request); if (contract) return contract;
    const previous = request.messages.at(-1)!.content;
    switch (step++) {
      case 0: return call("work_claim", { taskId: "T1", allowedPaths: ["."] });
      case 1:
        // Another process edits unprepared source while the command runs.
        pending.push(editWhenStarted(root, "started.flag", "src/ledger.py", "def balance():\n    return 42\n"));
        return call("run_shell", { command: "node", args: ["-e", waitForChange("started.flag", "src/ledger.py")], writePaths: ["."] });
      case 2:
        seen.push(previous);
        pending.push(editWhenStarted(root, "out/started.flag", "notes.md", "edited elsewhere\n"));
        return call("run_shell", { command: "node", args: ["-e", waitForChange("out/started.flag", "notes.md")], writePaths: ["out"] });
      case 3:
        seen.push(previous);
        // Renaming the directory that holds the protected file is refused by the sandbox.
        return call("run_shell", { command: "sh", args: ["-c", "mv src src.bak && mkdir src && cp src.bak/ledger.py src/ledger.py"], writePaths: ["."] });
      case 4:
        seen.push(previous);
        return call("run_shell", { command: "node", args: ["-e", "require('fs').writeFileSync('out/report.txt','ok');console.log('report written')"], writePaths: ["out"] });
      case 5: seen.push(previous); return call("work_block", { taskId: "T1", reason: "Conflict regression finished" });
      default: return reply("Stopped after recording the conflicts.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace" });
  if (!controller.isolation.available) { t.skip(controller.isolation.reason); return; }
  await controller.run("Produce the report without touching the ledger source.");
  await Promise.all(pending);
  assert.match(seen[0], /Protected source changed during run_shell: "src\/ledger\.py"/);
  assert.match(seen[0], /prepare_edit/);
  assert.match(seen[0], /watched file changed/, "the command's own output is kept");
  assert.match(seen[1], /outside the declared write paths during run_shell: "notes\.md"/);
  assert.match(seen[2], /EBUSY|busy|Operation not permitted/i);
  assert.ok(!existsSync(path.join(root, "src.bak")), "the directory holding protected source was not renamed");
  assert.equal(await fs.readFile(path.join(root, "src", "ledger.py"), "utf8"), "def balance():\n    return 42\n");
  assert.match(seen[3], /report written/);
  assert.equal(await fs.readFile(path.join(root, "out", "report.txt"), "utf8"), "ok");
});

test("rebuilding output and regenerating files the session wrote does not trip source protection", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-rebuild-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-rebuild-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "out"));
  await fs.writeFile(path.join(root, "src", "price.ts"), "export const price = (cents: number) => cents / 100;\n");
  // Output of an earlier build, present before the session started.
  await fs.writeFile(path.join(root, "out", "price.js"), "export const price = cents => cents;\n");
  // A build that removes its output root and writes it again (rm -rf out && tsc --outDir out).
  const build = "const fs=require('fs');fs.rmSync('out',{recursive:true,force:true});fs.mkdirSync('out');fs.writeFileSync('out/price.js',fs.readFileSync('src/price.ts','utf8').replace(': number',''));console.log('built')";
  const generate = (version: string) => `const fs=require('fs');fs.rmSync('gen/schema_pb2.py',{force:true});fs.writeFileSync('gen/schema_pb2.py','# generated ${version}\\n');console.log('generated ${version}')`;
  let step = 0; const seen: string[] = [];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    const contract = contractReviewFixture(request); if (contract) return contract;
    const previous = request.messages.at(-1)!.content;
    switch (step++) {
      case 0: return call("work_claim", { taskId: "T1", allowedPaths: ["."] });
      case 1: return call("run_shell", { command: "node", args: ["-e", build], writePaths: ["out"] });
      case 2: seen.push(previous); return call("run_shell", { command: "node", args: ["-e", build], writePaths: ["out"] });
      case 3: seen.push(previous); return call("run_shell", { command: "node", args: ["-e", generate("v1")], writePaths: ["gen"] });
      case 4: seen.push(previous); return call("run_shell", { command: "node", args: ["-e", generate("v2")], writePaths: ["gen"] });
      case 5:
        seen.push(previous);
        // Changed by someone else after the session wrote it: protected again.
        await fs.writeFile(path.join(root, "gen", "schema_pb2.py"), "# hand edited\n");
        return call("run_shell", { command: "node", args: ["-e", generate("v3")], writePaths: ["gen"] });
      case 6: seen.push(previous); return call("work_block", { taskId: "T1", reason: "Rebuild regression finished" });
      default: return reply("Rebuilt.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace" });
  if (!controller.isolation.available) { t.skip(controller.isolation.reason); return; }
  await controller.run("Build the project twice and regenerate the schema module.");
  assert.match(seen[0], /built/); assert.doesNotMatch(seen[0], /EBUSY|EROFS|read-only/i);
  assert.match(seen[1], /built/); assert.doesNotMatch(seen[1], /EBUSY|EROFS|read-only/i);
  assert.equal(await fs.readFile(path.join(root, "out", "price.js"), "utf8"), "export const price = (cents) => cents / 100;\n");
  assert.match(seen[2], /generated v1/);
  assert.match(seen[3], /generated v2/); assert.doesNotMatch(seen[3], /read-only/i);
  assert.match(seen[4], /EROFS|EBUSY|read-only|Operation not permitted/i);
  assert.match(seen[4], /kept read-only \(1 files: gen\/schema_pb2\.py\)/);
  assert.equal(await fs.readFile(path.join(root, "gen", "schema_pb2.py"), "utf8"), "# hand edited\n");
});
