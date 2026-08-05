import assert from "node:assert/strict";
import test from "node:test";
import {
  createRelevanceJudge,
  summarizeResultTitles,
  titlesShareTermsWithQuery,
} from "../RelevanceJudge.js";
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
  assert.equal(
    await judge({ query: "Describe the economic outlook", results }),
    true,
  );
});

test("NO sends the search to the web", async () => {
  // The case this exists for: a test fixture mentioning "GDP of France" scores
  // higher than a genuine repo question, so presence alone is not relevance.
  const judge = createRelevanceJudge({ provider: new StubProvider("NO") });
  assert.equal(await judge({ query: "What is the GDP of France?", results }), false);
});

test("the verdict is read case- and whitespace-insensitively", async () => {
  const judge = createRelevanceJudge({ provider: new StubProvider("  no.\n") });
  assert.equal(await judge({ query: "Describe the economic outlook", results }), false);
});

test("an unreadable verdict keeps the local results", async () => {
  // A needless web call is a worse failure than a slightly weak local hit.
  const judge = createRelevanceJudge({ provider: new StubProvider("I'm not sure") });
  assert.equal(await judge({ query: "Describe the economic outlook", results }), true);
});

test("the judge asks for a single token so a small model stays fast", async () => {
  const provider = new StubProvider("YES");
  await createRelevanceJudge({ provider })({ query: "Describe the economic outlook", results });
  assert.ok((provider.requests[0]?.maxTokens ?? 999) <= 10);
  assert.equal(provider.requests[0]?.toolChoice, "none");
});

test("the question and the titles both reach the model", async () => {
  // A query with no lexical overlap, so the pre-check defers to the judge.
  const provider = new StubProvider("YES");
  await createRelevanceJudge({ provider })({
    query: "What was France's economic output last year?",
    results,
  });
  const prompt = provider.requests[0]?.messages[1]?.content ?? "";
  assert.match(prompt, /economic output/);
  assert.match(prompt, /GatewayPlanner\.ts/);
});

test("an obvious match skips the model call entirely", async () => {
  // Asked whether LocalGatewayTaskRunner.ts could answer a question naming that
  // class, a small model said no — forcing a 45-second web search for a local
  // file. Lexical overlap settles this without asking.
  const provider = new StubProvider("NO");
  const judge = createRelevanceJudge({ provider });

  const verdict = await judge({
    query: "Summarize what the LocalGatewayTaskRunner class does",
    results: { hits: [{ rel_path: "packages/codali/src/gateway/LocalGatewayTaskRunner.ts" }] },
  });

  assert.equal(verdict, true);
  assert.equal(provider.requests.length, 0, "no model call for an obvious match");
});

test("no shared terms still goes to the judge", async () => {
  const provider = new StubProvider("NO");
  const judge = createRelevanceJudge({ provider });

  const verdict = await judge({
    query: "What is the GDP of France in 2025?",
    results: { hits: [{ rel_path: "packages/codali/src/gateway/Finalizer.test.ts" }] },
  });

  assert.equal(verdict, false);
  assert.equal(provider.requests.length, 1, "an ambiguous set is worth a model call");
});

test("common words alone do not count as a match", () => {
  assert.equal(
    titlesShareTermsWithQuery("What is the class file for this?", ["src/gateway/Planner.ts"]),
    false,
  );
});

test("a CamelCase symbol in the question matches the file that defines it", () => {
  // The measured failure: the question flattened to one token
  // `codaligatewayplannererror`, while the path flattened to
  // `gateway gatewayplanner ts`, so the correct file was discarded and the run
  // reported that the class could not be found.
  assert.equal(
    titlesShareTermsWithQuery("Which file defines the CodaliGatewayPlannerError class?", [
      "packages/codali/src/gateway/GatewayPlanner.ts",
    ]),
    true,
  );
});

test("an acronym boundary splits too", () => {
  assert.equal(
    titlesShareTermsWithQuery("where is the HTTPClient defined", ["src/net/HttpClient.ts"]),
    true,
  );
});

test("an unrelated question still does not match", () => {
  assert.equal(
    titlesShareTermsWithQuery("What is the capital of Australia?", [
      "packages/codali/src/gateway/GatewayPlanner.ts",
      "packages/codali/src/tools/ToolRegistry.ts",
    ]),
    false,
  );
});

test("a shared word must be a whole word, not a fragment", () => {
  // `StringUtils.ts` splits to `string utils`, so "string" matches; but a
  // question about "strings" must not match on a substring of some other word.
  assert.equal(titlesShareTermsWithQuery("what is a monad", ["src/util/Monadic.ts"]), false);
});
