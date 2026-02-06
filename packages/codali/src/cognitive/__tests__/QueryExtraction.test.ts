import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { expandQueriesWithProvider, extractQueries, extractQuerySignals } from "../QueryExtraction.js";

class StubProvider implements Provider {
  name = "stub";
  constructor(private response: ProviderResponse) {}

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return this.response;
  }
}

test("extractQueries includes file paths", { concurrency: false }, () => {
  const queries = extractQueries("Fix the bug in src/auth/login.ts and update docs", 3);
  assert.ok(queries.some((query) => query.includes("src/auth/login.ts")));
});

test("extractQueries includes quoted phrases", { concurrency: false }, () => {
  const queries = extractQueries('Update the "billing retry" flow', 3);
  assert.ok(queries.includes("billing retry"));
});

test("extractQueries falls back to full request", { concurrency: false }, () => {
  const queries = extractQueries("fix typo", 2);
  assert.ok(queries.includes("fix typo"));
});

test("extractQueries preserves key nouns for generic action verbs", { concurrency: false }, () => {
  const queries = extractQueries("Develop Secure Task Rendering Engine.", 3);
  const joined = queries.join(" ").toLowerCase();
  assert.ok(joined.includes("secure"));
  assert.ok(joined.includes("task"));
  assert.ok(joined.includes("rendering"));
});

test("extractQuerySignals returns keyword phrases for fuzzy requests", { concurrency: false }, () => {
  const signals = extractQuerySignals("Change heading colors to blue on the main page");
  assert.ok(signals.keywords.includes("heading"));
  assert.ok(signals.keywords.includes("colors"));
  assert.ok(signals.keyword_phrases.some((entry) => entry.includes("heading colors")));
});

test("expandQueriesWithProvider merges provider suggestions", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: JSON.stringify(["auth", "login flow"]) },
  });
  const expanded = await expandQueriesWithProvider(
    provider,
    "update login flow",
    ["login"],
    3,
    undefined,
    ["src/auth/login.ts"],
  );
  assert.ok(expanded.includes("auth"));
  assert.ok(expanded.includes("login"));
});

test("expandQueriesWithProvider keeps base queries when max queries is tight", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: JSON.stringify(["generic", "query", "noise"]) },
  });
  const expanded = await expandQueriesWithProvider(
    provider,
    "secure task rendering",
    ["secure task rendering", "task rendering"],
    2,
  );
  assert.deepEqual(expanded, ["secure task rendering", "task rendering"]);
});
