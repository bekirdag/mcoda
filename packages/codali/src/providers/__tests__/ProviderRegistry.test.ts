import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "../ProviderRegistry.js";
import type { Provider, ProviderConfig, ProviderRequest, ProviderResponse } from "../ProviderTypes.js";

test("ProviderRegistry registers and creates providers", { concurrency: false }, () => {
  const registry = new ProviderRegistry();
  const factory = (config: ProviderConfig): Provider => ({
    name: "stub",
    async generate(_request: ProviderRequest): Promise<ProviderResponse> {
      return {
        message: { role: "assistant", content: `model:${config.model}` },
      };
    },
  });

  registry.register("stub", factory);
  const provider = registry.create("stub", { model: "test-model" });
  assert.equal(provider.name, "stub");
});

test("ProviderRegistry throws on unknown provider", { concurrency: false }, () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.create("missing", { model: "x" }), /Unknown provider/);
});

test("ProviderRegistry rejects duplicate providers", { concurrency: false }, () => {
  const registry = new ProviderRegistry();
  const factory = (_config: ProviderConfig): Provider => ({
    name: "dup",
    async generate(_request: ProviderRequest): Promise<ProviderResponse> {
      return {
        message: { role: "assistant", content: "ok" },
      };
    },
  });

  registry.register("dup", factory);
  assert.throws(() => registry.register("dup", factory), /already registered/);
});
