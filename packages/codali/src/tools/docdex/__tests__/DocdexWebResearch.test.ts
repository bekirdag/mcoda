import test from "node:test";
import assert from "node:assert/strict";
import type { DocdexClient } from "../../../docdex/DocdexClient.js";
import { createDocdexTools } from "../DocdexTools.js";

test("empty web research does not issue a hidden second search and explicit retries retain bounded defaults", async () => {
  const calls: unknown[][] = [];
  const client = { webResearch: async (...args: unknown[]) => { calls.push(args); return { pages: [], unavailable: "No fetched evidence" }; } } as unknown as DocdexClient;
  const tool = createDocdexTools(client).find(tool => tool.name === "docdex_web_research")!;
  const result = await tool.handler({ query: "project specification" }, { workspaceRoot: "." });
  assert.equal(calls.length, 1); assert.match(result.output, /No fetched evidence/);
  assert.deepEqual(calls[0], ["project specification", { forceWeb: true, skipLocalSearch: true, webLimit: 3, noCache: undefined }]);
  await tool.handler({ query: "project specification", noCache: true }, { workspaceRoot: "." });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ["project specification", { forceWeb: true, skipLocalSearch: true, webLimit: 3, noCache: true }]);
});

test("web evidence preserves discovery links and distinguishes excerpts from generated summaries", async () => {
  const client = { webResearch: async () => ({ hits: [{ content: "unrelated repository content" }], webDiscovery: {
    discovery: { query: "specification", results: [{ url: "https://primary.example/spec", title: "Specification" }] },
    fetches: [
      { url: "https://secondary.example/page", content: "Fetched raw text", ai_digested_content: "Generated summary", relevance_score: 0.8 },
      { url: "https://secondary.example/digest", ai_digested_content: "Summary only" },
    ],
  } }) } as unknown as DocdexClient;
  const tool = createDocdexTools(client).find(tool => tool.name === "docdex_web_research")!;
  const result = await tool.handler({ query: "specification" }, { workspaceRoot: "." });
  const output = JSON.parse(result.output);
  assert.deepEqual(output.discoveries, [{ url: "https://primary.example/spec", title: "Specification", visited: false }]);
  assert.equal(output.pages[0].content, "Fetched raw text");
  assert.equal(output.pages[0].evidenceType, "fetched_excerpt");
  assert.equal(output.pages[1].evidenceType, "generated_summary");
  assert.equal(output.hits, undefined);
});

test("web evidence remains valid bounded JSON with escaped content and never changes citation URLs", async () => {
  let calls = 0;
  const url = "https://primary.example/spec?" + "x".repeat(600);
  const client = { webResearch: async () => { calls++; return { webDiscovery: {
    discovery: { query: "specification", results: Array.from({ length: 8 }, () => ({ url, title: '"\\'.repeat(100) })) },
    fetches: Array.from({ length: 6 }, () => ({ url, content: '"\\\n'.repeat(5000) })),
  } }; } } as unknown as DocdexClient;
  const result = await createDocdexTools(client).find(tool => tool.name === "docdex_web_research")!
    .handler({ query: "specification" }, { workspaceRoot: "." });
  const output = JSON.parse(result.output);
  assert.ok(result.output.length <= 3800);
  assert.equal(calls, 1);
  assert.equal(output.truncated, true);
  assert.ok(output.pages.length + output.discoveries.length > 0);
  for (const item of [...output.pages, ...output.discoveries]) assert.equal(item.url, url);
});
