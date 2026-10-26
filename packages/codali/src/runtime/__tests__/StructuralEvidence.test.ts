import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { missingStructuralEvidence, validAnalysisResult, writableInventory } from "../StructuralEvidence.js";
import { captureWorkspace } from "../WorkspaceSnapshot.js";

test("workspace aliases produce the same baseline and writable inventory as the canonical root", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codali-inventory-alias-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "real"); const alias = path.join(parent, "alias");
  await fs.mkdir(root); await fs.symlink(root, alias);
  await fs.writeFile(path.join(root, "note.txt"), "ok");
  assert.deepEqual(await captureWorkspace(alias), await captureWorkspace(root));
  assert.deepEqual(await writableInventory(alias, ["."]), await writableInventory(root, ["."]));
});

test("analysis receipts require both kinds for the same content and survive serialization", () => {
  const structure = { status: "success", analysis: { kind: "structure" as const, file: "src/a.ts", hash: "v1", valid: true } };
  const impact = { ...structure, analysis: { ...structure.analysis, kind: "impact" as const } };
  assert.deepEqual(missingStructuralEvidence("src/a.ts", "v1", [structure]), ["impact"]);
  const persisted = JSON.parse(JSON.stringify([structure, impact]));
  assert.deepEqual(missingStructuralEvidence("src/a.ts", "v1", persisted), []);
  assert.deepEqual(missingStructuralEvidence("src/a.ts", "v2", persisted), ["structure", "impact"]);
  assert.deepEqual(missingStructuralEvidence("src/b.ts", "v1", persisted), ["structure", "impact"]);
  assert.deepEqual(missingStructuralEvidence("src/a.ts", "v1", [structure, { ...impact, status: "failed" }]), ["impact"]);
  assert.deepEqual(missingStructuralEvidence("src/a.ts", "v1", [structure, { ...impact, analysis: { ...impact.analysis, valid: false } }]), ["impact"]);
  assert.deepEqual(missingStructuralEvidence("new.ts", "missing", []), []);
  assert.deepEqual(missingStructuralEvidence("README.md", "v1", []), []);
});

test("HTTP success, skipped parsers and results for another path are not structural evidence", () => {
  assert.equal(validAnalysisResult("structure", { file: "a.ts", outcome: { status: "ok" }, symbols: [] }, "a.ts"), true);
  assert.equal(validAnalysisResult("structure", { file: "a.ts", outcome: { status: "ok" }, nodes: [] }, "a.ts"), true);
  for (const payload of [{ ok: true }, { file: "a.ts", outcome: { status: "skipped" }, symbols: [] }, { file: "b.ts", outcome: { status: "ok" }, symbols: [] }]) assert.equal(validAnalysisResult("structure", payload, "a.ts"), false);
  assert.equal(validAnalysisResult("impact", { source: "a.ts", edges: [], inbound: [], outbound: [] }, "a.ts"), true);
  assert.equal(validAnalysisResult("impact", { source: "a.ts", error: "index missing", edges: [], inbound: [], outbound: [] }, "a.ts"), false);
});

test("writable inventory includes ignored sources and rejects alias, hard-link and oversized scopes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-source-scope-"));
  try {
    await fs.mkdir(path.join(root, "ignored")); await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await fs.writeFile(path.join(root, "ignored", "source.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, ".git", "config"), "private");
    const inventory = await writableInventory(root, ["."]);
    assert.ok(inventory["ignored/source.ts"]); assert.equal(inventory[".git/config"], undefined);
    await assert.rejects(writableInventory(root, ["."], 2), /narrower/);
    await fs.symlink("ignored", path.join(root, "alias"));
    await assert.rejects(writableInventory(root, ["alias"]), /canonical/);
    await fs.link(path.join(root, "ignored", "source.ts"), path.join(root, "copy.ts"));
    await assert.rejects(writableInventory(root, ["ignored"]), /Hard-linked/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
