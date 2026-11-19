import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEmbeddingPreprocessing, validateEmbeddingRequest, validateEmbeddingResponse } from "../EmbeddingContract.js";

test("embedding preprocessing requires an explicit, bounded contract without guessed defaults", () => {
  const base = { queryPrefix: "", documentPrefix: "", normalization: "none", pooling: "mean" };
  for (const normalization of ["none", "l2"]) {
    const input = { ...base, normalization };
    assert.deepEqual(validateEmbeddingPreprocessing(input), input);
    assert.notEqual(validateEmbeddingPreprocessing(input), input);
  }
  assert.doesNotThrow(() => validateEmbeddingPreprocessing({ ...base, queryPrefix: "q".repeat(256), documentPrefix: "d".repeat(256), pooling: "p".repeat(128) }));
  for (const value of [undefined, null, [], "text", 7, {}, { ...base, extra: true }]) {
    assert.throws(() => validateEmbeddingPreprocessing(value));
  }
  for (const key of Object.keys(base)) assert.throws(() => validateEmbeddingPreprocessing({ ...base, [key]: undefined }));
  for (const patch of [
    { queryPrefix: "q".repeat(257) }, { documentPrefix: "d".repeat(257) },
    { queryPrefix: "q\u0000" }, { documentPrefix: "d\n" }, { pooling: "p\u001f" },
    { pooling: "" }, { pooling: "  " }, { pooling: "p".repeat(129) },
    { normalization: "auto" }, { normalization: 1 },
  ]) assert.throws(() => validateEmbeddingPreprocessing({ ...base, ...patch }));
});

test("embedding requests preserve text and bound inputs and dimensions", () => {
  assert.deepEqual(validateEmbeddingRequest({ input: " search_query: hello " }, "nomic"), {
    input: [" search_query: hello "], model: "nomic", encoding_format: "float",
  });
  for (const input of [[], "", ["a", ""], [1], Array(129).fill("a"), "x".repeat(8193), Array(9).fill("x".repeat(8192))]) {
    assert.throws(() => validateEmbeddingRequest({ input }, "nomic"));
  }
  for (const extra of [{ encoding_format: "base64" }, { stream: true }, { dimensions: 0 }, { dimensions: 4097 }, { dimensions: 2.5 }]) {
    assert.throws(() => validateEmbeddingRequest({ input: "hi", ...extra }, "nomic"));
  }
  assert.throws(() => validateEmbeddingRequest({ input: "hi", dimensions: 384 }, "nomic", { embeddingDimensions: 768 }));
});

test("embedding responses enforce exact count, unique indices, finite vectors and identity", () => {
  const response = { model: "nomic", data: [{ index: 1, embedding: [1, 2] }, { index: 0, embedding: [3, 4] }], usage: { prompt_tokens: 4, total_tokens: 4 } };
  assert.deepEqual(validateEmbeddingResponse(response, 2, 2, "nomic").data.map(x => x.index), [0, 1]);
  assert.throws(() => validateEmbeddingResponse(response, 2, 3));
  assert.throws(() => validateEmbeddingResponse(response, 1, 2));
  assert.throws(() => validateEmbeddingResponse(response, 2, 2, "different"));
  for (const data of [
    [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [1, 2] }],
    [{ index: 0, embedding: [NaN, 2] }, { index: 1, embedding: [1, 2] }],
    [{ index: 0, embedding: [Infinity, 2] }, { index: 1, embedding: [1, 2] }],
    [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }],
    [{ index: 2, embedding: [1, 2] }, { index: 1, embedding: [1, 2] }],
  ]) assert.throws(() => validateEmbeddingResponse({ ...response, data }, 2, 2));
});
