import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QA_TECH_STACKS, QA_TEST_CATEGORY_ORDER } from "../QaTechStack.js";

describe("QaTechStack", () => {
  it("defines stable category order", () => {
    assert.deepEqual(QA_TEST_CATEGORY_ORDER, [
      "unit",
      "component",
      "integration",
      "api",
    ]);
  });

  it("includes all required stacks", () => {
    const ids = Object.keys(QA_TECH_STACKS).sort();
    assert.deepEqual(ids, [
      "android",
      "cross-stack",
      "dotnet",
      "flutter",
      "go",
      "ios",
      "java",
      "node",
      "php",
      "python",
      "react-native",
      "ruby",
    ]);
  });

  it("keeps preferred tools inside each stack catalog", () => {
    for (const stack of Object.values(QA_TECH_STACKS)) {
      const preferred = stack.preferred ?? {};
      for (const [category, tool] of Object.entries(preferred)) {
        const list = stack.tools[category as keyof typeof stack.tools] ?? [];
        assert.ok(
          list.includes(tool),
          `${stack.id} preferred ${category} tool missing: ${tool}`,
        );
      }
    }
  });
});
