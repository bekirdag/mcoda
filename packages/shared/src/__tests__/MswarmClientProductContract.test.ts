import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mswarmClientProductHeaders,
  resolveMswarmClientProduct,
} from "../mswarm/ClientProductContract.js";

const withEnv = (value: string | undefined, run: () => void): void => {
  const previous = process.env.MSWARM_CLIENT_PRODUCT;
  if (value === undefined) delete process.env.MSWARM_CLIENT_PRODUCT;
  else process.env.MSWARM_CLIENT_PRODUCT = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.MSWARM_CLIENT_PRODUCT;
    else process.env.MSWARM_CLIENT_PRODUCT = previous;
  }
};

describe("mswarm client product", () => {
  it("falls back to the deployment env so a host needs no code of its own", () => {
    withEnv("okacam", () => {
      assert.equal(resolveMswarmClientProduct(undefined), "okacam");
    });
  });

  it("prefers an explicit run-context product over the env", () => {
    withEnv("okacam", () => {
      assert.equal(resolveMswarmClientProduct("bdya"), "bdya");
    });
  });

  it("normalizes case and whitespace to match what mswarm stores", () => {
    withEnv(undefined, () => {
      assert.equal(resolveMswarmClientProduct("  OKACAM  "), "okacam");
    });
  });

  it("ignores a malformed product rather than failing the run", () => {
    // The header is optional. A bad value must degrade to "no product", leaving the
    // client identity to reach whatever it can on its own - never take the call down.
    withEnv(undefined, () => {
      assert.equal(resolveMswarmClientProduct("not a product!"), undefined);
      assert.equal(resolveMswarmClientProduct(""), undefined);
      assert.equal(resolveMswarmClientProduct(undefined), undefined);
    });
  });

  it("emits headers only when a product resolved", () => {
    withEnv(undefined, () => {
      assert.deepEqual(mswarmClientProductHeaders("okacam"), {
        "x-mswarm-client-product": "okacam",
      });
      assert.equal(mswarmClientProductHeaders(undefined), undefined);
      assert.equal(mswarmClientProductHeaders("not a product!"), undefined);
    });
  });
});
