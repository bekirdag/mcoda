import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GENERATIVE_OPERATION_DEFAULT_PATHS,
  GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS,
  isGenerativeOperationPath,
  normalizeGenerativeModalities,
  normalizeGenerativeModality,
  normalizeGenerativeOperation,
  normalizeGenerativeOperationPath,
  normalizeSelfHostedGenerativeOperation,
  type GenerativeRequestParameterAllowlist,
  type SelfHostedGenerativeOperation,
} from "../llm/GenerativeOperation.js";

describe("GenerativeOperation", () => {
  it("normalizes canonical operations and backward-compatible aliases", () => {
    assert.equal(normalizeGenerativeOperation("chat.completions"), "chat.completions");
    assert.equal(normalizeGenerativeOperation(" CHAT "), "chat.completions");
    assert.equal(normalizeGenerativeOperation("/v1/chat/completions"), "chat.completions");
    assert.equal(normalizeGenerativeOperation("image-generation"), "images.generations");
    assert.equal(normalizeGenerativeOperation("images"), "images.generations");
    assert.equal(normalizeGenerativeOperation("/v1/images/generations"), "images.generations");
    assert.equal(normalizeGenerativeOperation("audio-generation"), "audio.generations");
    assert.equal(normalizeGenerativeOperation("/v1/audio/generations"), "audio.generations");
    assert.equal(normalizeGenerativeOperation("video.generations"), undefined);
    assert.equal(normalizeGenerativeOperation(undefined), undefined);
  });

  it("normalizes and deduplicates supported modalities", () => {
    assert.equal(normalizeGenerativeModality("CHAT"), "text");
    assert.equal(normalizeGenerativeModality("images"), "image");
    assert.equal(normalizeGenerativeModality("audio"), "audio");
    assert.equal(normalizeGenerativeModality("video"), undefined);
    assert.deepEqual(
      normalizeGenerativeModalities([" text ", "images", "image", "audio", "video"]),
      ["text", "image", "audio"],
    );
    assert.equal(normalizeGenerativeModalities(["video", 42]), undefined);
    assert.equal(normalizeGenerativeModalities("text"), undefined);
  });

  it("accepts only strict origin-relative operation paths", () => {
    const accepted = [
      "/v1/chat/completions",
      "/v1/images/generations",
      "/custom/v1.0/generate_image",
      "/audio/generate-track",
    ];
    for (const path of accepted) {
      assert.equal(isGenerativeOperationPath(path), true, path);
      assert.equal(normalizeGenerativeOperationPath(path), path);
    }

    const rejected = [
      "",
      "v1/images/generations",
      "https://localhost/v1/images/generations",
      "//localhost/v1/images/generations",
      "/v1//images/generations",
      "/v1/./images",
      "/v1/../images",
      "/v1/%2e%2e/images",
      "/v1/images/generations?format=png",
      "/v1/images/generations#output",
      "/v1\\images\\generations",
      "/v1/images/generations/",
      " /v1/images/generations",
      "/v1/images/generations\n",
    ];
    for (const path of rejected) {
      assert.equal(isGenerativeOperationPath(path), false, path);
      assert.equal(normalizeGenerativeOperationPath(path), undefined);
    }
  });

  it("builds a safe descriptor from an operation alias with legacy defaults", () => {
    assert.deepEqual(normalizeSelfHostedGenerativeOperation("image"), {
      operation: "images.generations",
      path: GENERATIVE_OPERATION_DEFAULT_PATHS["images.generations"],
      method: "POST",
      requestParameterAllowlist: [
        ...GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS["images.generations"],
      ],
    });
  });

  it("normalizes descriptor fields and intersects request parameters with the operation allowlist", () => {
    assert.deepEqual(
      normalizeSelfHostedGenerativeOperation({
        operation: "AUDIO-GENERATION",
        path: "/local/audio/generate",
        method: "post",
        requestParameterAllowlist: [
          "model",
          "prompt",
          "messages",
          "seed",
          "sample_rate",
          "seed",
          42,
        ],
        responseFormats: [" WAV ", "wav", "flac", "bad format", 42],
        outputMimeTypes: [" Audio/WAV ", "audio/wav", "audio/flac", "not-a-mime"],
        limits: {
          minDurationSeconds: 3,
          maxDurationSeconds: 300,
          maxSampleRate: 96_000,
          maxSteps: 200,
          maxOutputBytes: 64 * 1024 * 1024,
          maxN: 0,
          maxWidth: 1.5,
          unknownLimit: 1,
        },
      }),
      {
        operation: "audio.generations",
        path: "/local/audio/generate",
        method: "POST",
        requestParameterAllowlist: ["model", "prompt", "seed", "sample_rate"],
        responseFormats: ["wav", "flac"],
        outputMimeTypes: ["audio/wav", "audio/flac"],
        limits: {
          minDurationSeconds: 3,
          maxDurationSeconds: 300,
          maxSampleRate: 96_000,
          maxSteps: 200,
          maxOutputBytes: 64 * 1024 * 1024,
        },
      },
    );
  });

  it("fails closed for invalid operation routing and malformed optional allowlists", () => {
    assert.equal(
      normalizeSelfHostedGenerativeOperation({
        operation: "video.generations",
        path: "/v1/video/generations",
      }),
      undefined,
    );
    assert.equal(
      normalizeSelfHostedGenerativeOperation({
        operation: "images.generations",
        path: "https://example.test/v1/images/generations",
      }),
      undefined,
    );
    assert.equal(
      normalizeSelfHostedGenerativeOperation({
        operation: "images.generations",
        method: "GET",
      }),
      undefined,
    );

    const normalized = normalizeSelfHostedGenerativeOperation({
      operation: "chat",
      requestParameterAllowlist: "messages",
      responseFormats: "json",
      outputMimeTypes: ["not-a-mime"],
      limits: {
        maxRequestBytes: -1,
      },
    });
    assert.deepEqual(normalized, {
      operation: "chat.completions",
      path: "/v1/chat/completions",
      method: "POST",
      requestParameterAllowlist: [],
      outputMimeTypes: [],
    });
  });

  it("provides operation-specific request parameter types", () => {
    const imageParameters: GenerativeRequestParameterAllowlist<"images.generations"> = [
      "model",
      "prompt",
      "seed",
    ];
    const imageOperation: SelfHostedGenerativeOperation<"images.generations"> = {
      operation: "images.generations",
      path: "/v1/images/generations",
      requestParameterAllowlist: imageParameters,
      limits: {
        maxN: 1,
        maxSteps: 200,
      },
    };

    assert.deepEqual(imageOperation.requestParameterAllowlist, ["model", "prompt", "seed"]);
    assert.equal(imageOperation.limits?.maxN, 1);
  });
});
