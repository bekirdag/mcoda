import assert from "node:assert/strict";
import test from "node:test";
import { createRelevanceJudge, summarizeResultTitles } from "../RelevanceJudge.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";

class StubProvider implements Provider {
  readonly name = "stub";
  readonly requests: ProviderRequest[] = [];
  constructor(private readonly reply: string | Error) {}
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.reply instanceof Error) throw this.reply;
    return { message: { role: "assistant", content: this.reply } };
  }
}

const results = {
  hits: [
    { rel_path: "packages/codali/src/gateway/GatewayPlanner.ts", score: 14 },
    { rel_path: "packages/codali/src/gateway/__tests__/Finalizer.test.ts", score: 13 },
  ],
};

test("only titles are sent to the judge, never snippets", () => {
  // Sending contents would cost more than the web call being avoided.
  const titles = summarizeResultTitles(results);
  assert.deepEqual(titles, [
    "packages/codali/src/gateway/GatewayPlanner.ts",
    "packages/codali/src/gateway/__tests__/Finalizer.test.ts",
  ]);
});

test("an empty result set needs no judgement", async () => {
  const provider = new StubProvider("NO");
  const judge = createRelevanceJudge({ provider });
  assert.equal(await judge({ query: "anything", results: { hits: [] } }), true);
  assert.equal(provider.requests.length, 0, "no model call for an empty set");
});

test("YES keeps the local results", async () => {
  const judge = createRelevanceJudge({ provider: new StubProvider("YES") });
  assert.equal(await judge({ query: "where is the planner?", results }), true);
});

test("NO sends the search to the web", async () => {
  // The case this exists for: a test fixture mentioning "GDP of France" scores
  // higher than a genuine repo question, so presence alone is not relevance.
  const judge = createRelevanceJudge({ provider: new StubProvider("NO") });
  assert.equal(await judge({ query: "What is the GDP of France?", results }), false);
});

test("the verdict is read case- and whitespace-insensitively", async () => {
  const judge = createRelevanceJudge({ provider: new StubProvider("  no.\n") });
  assert.equal(await judge({ query: "q", results }), false);
});

test("an unreadable verdict keeps the local results", async () => {
  // A needless web call is a worse failure than a slightly weak local hit.
  const judge = createRelevanceJudge({ provider: new StubProvider("I'm not sure") });
  assert.equal(await judge({ query: "q", results }), true);
});

test("the judge asks for a single token so a small model stays fast", async () => {
  const provider = new StubProvider("YES");
  await createRelevanceJudge({ provider })({ query: "q", results });
  assert.ok((provider.requests[0]?.maxTokens ?? 999) <= 10);
  assert.equal(provider.requests[0]?.toolChoice, "none");
});

test("the question and the titles both reach the model", async () => {
  const provider = new StubProvider("YES");
  await createRelevanceJudge({ provider })({ query: "where is the planner?", results });
  const prompt = provider.requests[0]?.messages[1]?.content ?? "";
  assert.match(prompt, /where is the planner\?/);
  assert.match(prompt, /GatewayPlanner\.ts/);
});
