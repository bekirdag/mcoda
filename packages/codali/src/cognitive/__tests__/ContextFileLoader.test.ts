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
  assert.ok(focus[0]?.sliceStrategy?.startsWith("head_middle_tail"));
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

test("ContextFileLoader extracts text content from docdex open payload", { concurrency: false }, async () => {
  class OpenLinesClient extends StubDocdexClient {
    openCalls: unknown[] = [];
    async openFile(_filePath: string, options?: unknown): Promise<unknown> {
      this.openCalls.push(options);
      return {
        lines: [{ text: "line one" }, { text: "line two" }],
      };
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-loader-"));
  const filePath = path.join(tmpDir, "src", "file.ts");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "fallback-from-fs", "utf8");
  const client = new OpenLinesClient();
  const loader = new ContextFileLoader(client as unknown as DocdexClient, {
    workspaceRoot: tmpDir,
    readStrategy: "docdex",
    focusMaxFileBytes: 500,
    peripheryMaxBytes: 100,
    skeletonizeLargeFiles: true,
  });

  const focus = await loader.loadFocus(["src/file.ts"]);
  assert.equal(focus.length, 1);
  assert.equal(focus[0]?.content, "line one\nline two");
  assert.deepEqual(client.openCalls[0], { clamp: true });
});

test("ContextFileLoader falls back to fs when docdex open payload has no text", { concurrency: false }, async () => {
  class EmptyPayloadClient extends StubDocdexClient {
    async openFile(_filePath: string): Promise<unknown> {
      return { path: "src/file.ts", total_lines: 12 };
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-loader-"));
  const filePath = path.join(tmpDir, "src", "file.ts");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "fallback-from-fs", "utf8");
  const loader = new ContextFileLoader(new EmptyPayloadClient() as unknown as DocdexClient, {
    workspaceRoot: tmpDir,
    readStrategy: "docdex",
    focusMaxFileBytes: 500,
    peripheryMaxBytes: 100,
    skeletonizeLargeFiles: true,
  });

  const focus = await loader.loadFocus(["src/file.ts"]);
  assert.equal(focus.length, 1);
  assert.ok(focus[0]?.content.includes("fallback-from-fs"));
});

test("ContextFileLoader records load errors per file and continues loading", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-loader-errors-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/existing.ts"), "export const ok = true;", "utf8");
  writeFileSync(path.join(tmpDir, "docs/readme.md"), "Doc content", "utf8");
  const loader = new ContextFileLoader(new StubDocdexClient() as unknown as DocdexClient, {
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    focusMaxFileBytes: 200,
    peripheryMaxBytes: 200,
    skeletonizeLargeFiles: true,
  });

  const focus = await loader.loadFocus(["src/missing.ts", "src/existing.ts"]);
  const periphery = await loader.loadPeriphery(["docs/missing.md", "docs/readme.md"]);

  assert.equal(focus.length, 1);
  assert.equal(focus[0]?.path, "src/existing.ts");
  assert.equal(periphery.length, 1);
  assert.equal(periphery[0]?.path, "docs/readme.md");
  assert.ok(
    loader.loadErrors.some(
      (entry) => entry.path === "src/missing.ts" && entry.role === "focus",
    ),
  );
  assert.ok(
    loader.loadErrors.some(
      (entry) => entry.path === "docs/missing.md" && entry.role === "periphery",
    ),
  );
});
