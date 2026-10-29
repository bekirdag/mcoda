import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillCatalog } from "../SkillCatalog.js";
import { PermissionGate } from "../../permissions/PermissionGate.js";
import { toolDescriptorFor } from "../../tools/ToolRegistry.js";

const fixture = async (t: test.TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".codali", "skills", "example"); await fs.mkdir(directory, { recursive: true });
  const source = path.join(directory, "SKILL.md");
  const content = "---\nname: example\ndescription: >-\n  Explain a project\n  with actual evidence.\n---\n\nBODY_SENTINEL: use actual sources.\n";
  await fs.writeFile(source, content);
  const catalog = new SkillCatalog({ workspaceRoot: root, includeUser: false, includeBuiltin: false });
  return { root, directory, source, content, catalog };
};

test("skill discovery stages metadata and reads actual instructions with hashes on demand", async t => {
  const { catalog, content } = await fixture(t); await catalog.refresh();
  const { skills, warnings } = catalog.list(); assert.equal(skills.length, 1); assert.deepEqual(warnings, []);
  assert.equal(skills[0].description, "Explain a project with actual evidence.");
  assert.doesNotMatch(catalog.prompt(), /BODY_SENTINEL/);
  const loaded = await catalog.read(skills[0].id); assert.equal(loaded.content, content); assert.equal(loaded.sha256, skills[0].sha256);
  for (const tool of catalog.tools()) await new PermissionGate("plan").authorize(toolDescriptorFor(tool), {});
});

test("skill resource pagination preserves text through the serialized tool-result ceiling", async t => {
  const { catalog, directory } = await fixture(t); await catalog.refresh();
  const contents = '\u0001"quoted"\n'.repeat(1800); await fs.writeFile(path.join(directory, "reference.txt"), contents);
  let offset = 0, restored = "";
  do {
    const result = await catalog.read("example", "reference.txt", offset);
    assert.ok(JSON.stringify(result).length <= 3800); restored += result.content;
    if (result.nextOffset === null) break;
    assert.ok(Number(result.nextOffset) > offset); offset = Number(result.nextOffset);
  } while (true);
  assert.equal(restored, contents);
});

test("workspace aliases discover local skills while actual outside roots remain rejected", async t => {
  const { root, content } = await fixture(t);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codali-skill-alias-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const alias = path.join(parent, "workspace"), outside = path.join(parent, "outside");
  await fs.symlink(root, alias, "dir");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "SKILL.md"), "---\nname: escaped\ndescription: Must not load.\n---\nOutside workspace.\n");
  await fs.mkdir(path.join(root, ".agents"));
  await fs.symlink(outside, path.join(root, ".agents", "skills"), "dir");
  const catalog = new SkillCatalog({ workspaceRoot: alias, includeUser: false, includeBuiltin: false });
  await catalog.refresh();
  assert.deepEqual(catalog.list().skills.map(skill => skill.name), ["example"]);
  assert.equal((await catalog.read("example")).content, content);
  assert.equal(catalog.list().warnings.length, 1);
  assert.match(catalog.list().warnings[0], /escapes the workspace/);
});

test("skill reads reject traversal, symlink escapes, binary resources and modified instructions", async t => {
  const { catalog, source, directory, root } = await fixture(t); await catalog.refresh();
  await fs.writeFile(path.join(root, "outside.txt"), "private");
  await fs.symlink(path.join(root, "outside.txt"), path.join(directory, "escape.txt"));
  await assert.rejects(catalog.read("example", "../../outside.txt"), /within/);
  await assert.rejects(catalog.read("example", "escape.txt"), /escapes/);
  await fs.writeFile(path.join(directory, "image.bin"), "hello\0world");
  await assert.rejects(catalog.read("example", "image.bin"), /not text/);
  await fs.writeFile(path.join(directory, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(catalog.read("example", "invalid.txt"), /encoded data/);
  await fs.appendFile(source, "changed"); await assert.rejects(catalog.read("example"), /changed/);
});

test("escaped skill metadata stays bounded while list pagination retains every skill", async t => {
  const { catalog, root } = await fixture(t);
  for (let i = 0; i < 8; i++) {
    const dir = path.join(root, ".codali", "skills", `escaped-${i}`); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: escaped-${i}\ndescription: ${JSON.stringify('"\\'.repeat(200))}\ncompatibility: ${JSON.stringify('"\\'.repeat(240))}\n---\nInstructions.\n`);
  }
  await catalog.refresh();
  const tool = catalog.tools().find(tool => tool.name === "skill_list")!;
  let offset = 0; const ids = new Set<string>();
  do {
    const result = await tool.handler({ offset }, { workspaceRoot: root }); assert.ok(result.output.length <= 3800);
    const page = JSON.parse(result.output);
    for (const skill of page.skills) { assert.ok(!ids.has(skill.id)); ids.add(skill.id); }
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  } while (true);
  assert.equal(ids.size, 9);
});

test("invalid YAML, aliases, oversized sources and duplicate names never silently select a skill", async t => {
  const { catalog, root } = await fixture(t);
  const add = async (name: string, content: string) => { const dir = path.join(root, ".codali", "skills", name); await fs.mkdir(dir); await fs.writeFile(path.join(dir, "SKILL.md"), content); };
  await add("duplicate", "---\nname: example\ndescription: Another skill.\n---\nDifferent body.");
  await add("invalid", "---\nname: invalid\nname: duplicate\ndescription: broken\n---\n");
  await add("alias", "---\nname: &anchor alias\ndescription: *anchor\n---\n");
  await add("huge", "x".repeat(65537));
  await catalog.refresh(); assert.equal(catalog.list().skills.length, 2); assert.equal(catalog.list().warnings.length, 3);
  await assert.rejects(catalog.read("example"), /ambiguous/);
  assert.match(String((await catalog.read(catalog.list().skills[0].id)).content), /example/);
});

test("disabled discovery does not load builtins or configured directories", async t => {
  const { root } = await fixture(t);
  const catalog = new SkillCatalog({ workspaceRoot: root, enabled: false, directories: [root] }); await catalog.refresh();
  assert.deepEqual(catalog.list(), { skills: [], warnings: [] }); assert.equal(catalog.prompt(), "");
  await assert.rejects(catalog.read("planning"), /Unknown/);
});

test("configured roots support nested Mac skill folders without executing scripts", async t => {
  const { root } = await fixture(t), imported = path.join(root, "mac", "synced", "collection", "planner");
  await fs.mkdir(imported, { recursive: true });
  await fs.writeFile(path.join(imported, "SKILL.md"), "---\nname: mac-planner\ndescription: Plan with milestones.\ncompatibility: Requires macOS and osascript.\nallowed-tools: run_shell\n---\nRead scripts/setup.sh when needed.");
  await fs.mkdir(path.join(imported, "scripts")); await fs.writeFile(path.join(imported, "scripts", "setup.sh"), "touch NEVER_EXECUTED");
  const catalog = new SkillCatalog({ workspaceRoot: root, directories: ["mac"], includeUser: false, includeBuiltin: false }); await catalog.refresh();
  assert.match(String((await catalog.read("mac-planner")).content), /allowed-tools/);
  assert.equal((await catalog.read("mac-planner")).hostPlatform, process.platform);
  assert.equal(catalog.list().skills.find(skill => skill.name === "mac-planner")?.compatibility, "Requires macOS and osascript.");
  assert.equal((await catalog.read("mac-planner", "scripts/setup.sh")).content, "touch NEVER_EXECUTED");
  await assert.rejects(fs.access(path.join(root, "NEVER_EXECUTED")));
  await assert.rejects(new PermissionGate("plan").authorize({ name: "run_shell", description: "Run a command", capability: "shell", readOnly: false }, {}), /read operations only/);
});
