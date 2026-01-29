import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { expandQueriesWithProvider, extractQueries } from "../QueryExtraction.js";

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
