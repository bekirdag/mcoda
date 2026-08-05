import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createImageGenerationTool, IMAGE_TOOL_NAME } from "../ImageGenerationTool.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = PNG_BYTES.toString("base64");

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async arrayBuffer() {
      return PNG_BYTES.buffer.slice(0) as ArrayBuffer;
    },
  }) as unknown as Response;

const workspace = async (): Promise<string> => mkdtemp(path.join(tmpdir(), "codali-img-"));

test("image generation is an ordinary tool in the media capability", async () => {
  const tool = createImageGenerationTool({
    config: { baseUrl: "http://localhost:9999/v1", model: "sd" },
    workspaceRoot: await workspace(),
  });
  assert.equal(tool.name, IMAGE_TOOL_NAME);
  assert.equal(tool.capability, "media");
  assert.match(tool.description, /Generate an image/);
});

test("a b64 response is written to disk and returned as a path", async () => {
  const root = await workspace();
  const artifacts: unknown[] = [];
  const tool = createImageGenerationTool({
    config: { baseUrl: "http://localhost:9999/v1", model: "sd" },
    workspaceRoot: root,
    runId: "run-1",
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }),
    onArtifact: (artifact) => artifacts.push(artifact),
  });

  const result = await tool.handler({ prompt: "a puppy" }, { workspaceRoot: root });

  const filePath = (result.data as { path: string }).path;
  assert.match(filePath, /\.codali\/artifacts\/run-1\/img-.*\.png$/);
  assert.deepEqual(await readFile(filePath), PNG_BYTES);
  assert.equal(artifacts.length, 1);
});

test("the tool returns a path, never the image bytes", async () => {
  // Inlining base64 would blow the context budget and fill the trace.
  const root = await workspace();
  const tool = createImageGenerationTool({
    config: { baseUrl: "http://localhost:9999/v1", model: "sd" },
    workspaceRoot: root,
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }),
  });
  const result = await tool.handler({ prompt: "a puppy" }, { workspaceRoot: root });
  assert.ok(!result.output.includes(PNG_B64));
  assert.match(result.output, /wrote it to/);
});

test("a url response is downloaded", async () => {
  const root = await workspace();
  let downloaded = false;
  const tool = createImageGenerationTool({
    config: { baseUrl: "http://localhost:9999/v1", model: "sd" },
    workspaceRoot: root,
    fetchImpl: async (input) => {
      if (String(input).includes("images/generations")) {
        return jsonResponse({ data: [{ url: "http://cdn.example/a.png" }] });
      }
      downloaded = true;
      return jsonResponse({});
    },
  });
  await tool.handler({ prompt: "a puppy" }, { workspaceRoot: root });
  assert.equal(downloaded, true);
});

test("an empty prompt is rejected before any request is made", async () => {
  const root = await workspace();
  let called = false;
  const tool = createImageGenerationTool({
    config: { baseUrl: "http://localhost:9999/v1", model: "sd" },
    workspaceRoot: root,
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    () => tool.handler({ prompt: "   " }, { workspaceRoot: root }),
    /prompt is required/,
  );
  assert.equal(called, false);
});

test("a server error is reported and retryable when transient", async () => {
  const root = await workspace();
  const tool = createImageGenerationTool({
    config: { baseUrl: "http://localhost:9999/v1", model: "sd" },
    workspaceRoot: root,
    fetchImpl: async () => jsonResponse({}, 503),
  });
  await assert.rejects(
    () => tool.handler({ prompt: "x" }, { workspaceRoot: root }),
    (error: unknown) => (error as { retryable?: boolean }).retryable === true,
  );
});

test("a response with no image data fails rather than writing an empty file", async () => {
  const root = await workspace();
  const tool = createImageGenerationTool({
    config: { baseUrl: "http://localhost:9999/v1", model: "sd" },
    workspaceRoot: root,
    fetchImpl: async () => jsonResponse({ data: [] }),
  });
  await assert.rejects(
    () => tool.handler({ prompt: "x" }, { workspaceRoot: root }),
    /no image data/,
  );
});

test("the endpoint is built from the configured base url", async () => {
  const root = await workspace();
  let seenUrl = "";
  const tool = createImageGenerationTool({
    config: { baseUrl: "http://localhost:9999/v1", model: "sd" },
    workspaceRoot: root,
    fetchImpl: async (input) => {
      seenUrl = String(input);
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    },
  });
  await tool.handler({ prompt: "x" }, { workspaceRoot: root });
  assert.equal(seenUrl, "http://localhost:9999/v1/images/generations");
});
