import assert from "node:assert/strict";
import test from "node:test";
import { DocdexClient } from "../../../docdex/DocdexClient.js";
import { createDocdexTools, normalizeWebQuery, resetWebResearchBackoff } from "../DocdexTools.js";

const refusing = (status: number, details?: Record<string, unknown>) => {
  const client = new DocdexClient({ baseUrl: "http://127.0.0.1:1", repoRoot: process.cwd() });
  let calls = 0;
  (client as unknown as { webResearch: unknown }).webResearch = async () => {
    calls += 1;
    const error = Object.assign(new Error("quota"), { status, details });
    throw error;
  };
  (client as unknown as { search: unknown }).search = async () => ({ hits: [] });
  return { client, calls: () => calls };
};

const webTool = (client: DocdexClient) =>
  createDocdexTools(client).find((tool) => tool.name === "docdex_web_research")!;

test("a spent quota is asked once, not once per question", async () => {
  // Measured upstream: ~366 attempts in two hours, ~4,400 a day, against a
  // monthly allowance of 5,000. The answer does not change between callers.
  resetWebResearchBackoff();
  const { client, calls } = refusing(402);
  const tool = webTool(client);
  const context = { workspaceRoot: process.cwd() };

  for (let i = 0; i < 5; i += 1) {
    const result = await tool.handler({ query: `question ${i}` }, context);
    assert.match(result.output, /unavailable/);
  }
  assert.equal(calls(), 1, "only the first question should reach the provider");
  resetWebResearchBackoff();
});

test("each refusing status opens the circuit", async () => {
  for (const status of [401, 402, 403, 429]) {
    resetWebResearchBackoff();
    const { client, calls } = refusing(status);
    const tool = webTool(client);
    await tool.handler({ query: "a" }, { workspaceRoot: process.cwd() });
    await tool.handler({ query: "b" }, { workspaceRoot: process.cwd() });
    assert.equal(calls(), 1, `status ${status} should stop the second attempt`);
  }
  resetWebResearchBackoff();
});

test("an ordinary failure is not treated as a spent quota", async () => {
  // A 500 is the provider having a bad moment, not a closed door.
  resetWebResearchBackoff();
  const { client, calls } = refusing(500);
  const tool = webTool(client);
  await assert.rejects(() => tool.handler({ query: "a" }, { workspaceRoot: process.cwd() }));
  await assert.rejects(() => tool.handler({ query: "b" }, { workspaceRoot: process.cwd() }));
  assert.equal(calls(), 2);
  resetWebResearchBackoff();
});

test("Retry-After decides when to try again, not a fixed hour", async () => {
  resetWebResearchBackoff();
  const { client } = refusing(402, { retry_after_ms: 1 });
  const tool = webTool(client);
  await tool.handler({ query: "a" }, { workspaceRoot: process.cwd() });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await tool.handler({ query: "b" }, { workspaceRoot: process.cwd() });
  // The circuit reopened, so the call was attempted again and refused again.
  assert.match(result.output, /unavailable/);
  resetWebResearchBackoff();
});

test("a restarting service is waited out in seconds, not a quarter hour", async () => {
  // The upstream gateway answers a cold start with 503 and a Retry-After now,
  // instead of a bodyless 502. Treating that like a spent quota would turn a
  // container recreate into fifteen minutes of self-inflicted outage.
  resetWebResearchBackoff();
  const { client } = refusing(503);
  const tool = webTool(client);
  const result = await tool.handler({ query: "a" }, { workspaceRoot: process.cwd() });
  assert.match(result.output, /not retrying for \d+s/);
  resetWebResearchBackoff();
});

test("a spent quota is still waited out in minutes", async () => {
  resetWebResearchBackoff();
  const { client } = refusing(402);
  const tool = webTool(client);
  const result = await tool.handler({ query: "a" }, { workspaceRoot: process.cwd() });
  assert.match(result.output, /not retrying for \d+m/);
  resetWebResearchBackoff();
});

test("Retry-After wins over either default", async () => {
  resetWebResearchBackoff();
  const { client } = refusing(503, { retry_after_ms: 120_000 });
  const tool = webTool(client);
  const result = await tool.handler({ query: "a" }, { workspaceRoot: process.cwd() });
  // Two minutes is longer than the transient default; the provider's word wins.
  assert.match(result.output, /not retrying for 2m/);
  resetWebResearchBackoff();
});

test("a malformed query never reaches the provider", async () => {
  // Measured at the gateway: 8 of 24 requests in an hour were 400s, not quota
  // refusals. A rejected request still spends the allowance.
  resetWebResearchBackoff();
  const { client, calls } = refusing(402);
  const tool = webTool(client);
  for (const query of ["", "   ", "\n\t "]) {
    const result = await tool.handler({ query }, { workspaceRoot: process.cwd() });
    assert.match(result.output, /empty query/);
  }
  assert.equal(calls(), 0, "nothing malformed should cost a request");
  resetWebResearchBackoff();
});

test("a pasted paragraph is trimmed to a query", () => {
  const long = "how many hours did the team log ".repeat(40);
  const normalized = normalizeWebQuery(long);
  assert.ok(normalized);
  assert.ok(normalized!.length <= 400, `still ${normalized!.length} chars`);
  assert.ok(normalized!.startsWith("how many hours"));
});

test("whitespace is collapsed rather than sent as-is", () => {
  assert.equal(normalizeWebQuery("  UK   inflation\n\trate  "), "UK inflation rate");
  assert.equal(normalizeWebQuery("   "), undefined);
  assert.equal(normalizeWebQuery(undefined), undefined);
});
