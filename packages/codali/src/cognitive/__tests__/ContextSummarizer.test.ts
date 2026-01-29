import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { ContextSummarizer } from "../ContextSummarizer.js";

class StubProvider implements Provider {
  name = "stub";
  constructor(private response: ProviderResponse) {}

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return this.response;
  }
}

test("ContextSummarizer returns system summary message", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "Summary of decisions." },
  });
  const summarizer = new ContextSummarizer(provider, { maxTokens: 64 });
  const summary = await summarizer.summarize([
    { role: "user", content: "Do the thing" },
    { role: "assistant", content: "We will do it" },
  ]);

  assert.equal(summary.role, "system");
  assert.equal(summary.content.includes("Context summary:"), true);
  assert.equal(summary.content.includes("Summary of decisions."), true);
});

test("ContextSummarizer rejects empty responses", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "  " },
  });
  const summarizer = new ContextSummarizer(provider);
  await assert.rejects(() => summarizer.summarize([{ role: "user", content: "hello" }]), /response is empty/);
});
