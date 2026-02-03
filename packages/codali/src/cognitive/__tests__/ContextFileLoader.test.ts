import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DocdexClient } from "../../docdex/DocdexClient.js";
import { ContextFileLoader } from "../ContextFileLoader.js";

class StubDocdexClient {
  async openFile(filePath: string): Promise<unknown> {
    return { path: filePath, content: "stub" };
  }

  async symbols(): Promise<unknown> {
    return { symbols: ["Foo", "Bar"] };
  }

  async ast(): Promise<unknown> {
    return { nodes: [{ start_line: 1, end_line: 2 }] };
  }
}

test("ContextFileLoader loads focus files and skeletonizes large content", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-loader-"));
  const largePath = path.join(tmpDir, "large.ts");
  const largeContent = "export const big = () => {\n" + "x".repeat(200) + "\n};\n";
  writeFileSync(largePath, largeContent, "utf8");

  const loader = new ContextFileLoader(new StubDocdexClient() as unknown as DocdexClient, {
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    focusMaxFileBytes: 80,
    peripheryMaxBytes: 40,
    skeletonizeLargeFiles: true,
  });

  const focus = await loader.loadFocus(["large.ts"]);
  assert.equal(focus.length, 1);
  assert.equal(focus[0]?.truncated, true);
  assert.ok(focus[0]?.content.includes("...truncated..."));
  assert.ok(focus[0]?.content.includes("ast_slice"));
  assert.ok(focus[0]?.content.includes("symbols"));
});

test("ContextFileLoader loads periphery as symbols", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-loader-"));
  const loader = new ContextFileLoader(new StubDocdexClient() as unknown as DocdexClient, {
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    focusMaxFileBytes: 80,
    peripheryMaxBytes: 40,
    skeletonizeLargeFiles: true,
  });

  const periphery = await loader.loadPeriphery(["src/user.ts"]);
  assert.equal(periphery.length, 1);
  assert.ok(periphery[0]?.content.includes("symbols"));
  assert.equal(periphery[0]?.role, "periphery");
});

test("ContextFileLoader loads doc periphery as content", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-loader-"));
  const docsDir = path.join(tmpDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, "readme.md"), "Doc content", "utf8");
  const loader = new ContextFileLoader(new StubDocdexClient() as unknown as DocdexClient, {
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    focusMaxFileBytes: 80,
    peripheryMaxBytes: 40,
    skeletonizeLargeFiles: true,
  });

  const periphery = await loader.loadPeriphery(["docs/readme.md"]);
  assert.equal(periphery.length, 1);
  assert.equal(periphery[0]?.role, "periphery");
  assert.ok(periphery[0]?.content.includes("Doc content"));
  assert.equal(periphery[0]?.sliceStrategy, "doc_full");
});

test("ContextFileLoader truncates periphery when over limit", { concurrency: false }, async () => {
  class LargeSymbolClient extends StubDocdexClient {
    async symbols(): Promise<unknown> {
      return { symbols: ["x".repeat(200)] };
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-loader-"));
  const loader = new ContextFileLoader(new LargeSymbolClient() as unknown as DocdexClient, {
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    focusMaxFileBytes: 80,
    peripheryMaxBytes: 40,
    skeletonizeLargeFiles: true,
  });

  const periphery = await loader.loadPeriphery(["src/large.ts"]);
  assert.equal(periphery.length, 1);
  assert.equal(periphery[0]?.truncated, true);
  assert.ok(periphery[0]?.content.length <= 40);
});
