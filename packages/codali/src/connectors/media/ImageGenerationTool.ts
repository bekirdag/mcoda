import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolExecutionError } from "../../tools/ToolTypes.js";
import type { ToolDefinition } from "../../tools/ToolTypes.js";

/**
 * Image generation, as an ordinary tool.
 *
 * The original design gave media its own orchestration route, which forced
 * every request to be classified as "media or not" up front and duplicated the
 * planning path. It is simpler and more accurate to treat generation as a tool
 * the orchestrator may call: "generate an image of a puppy" becomes a plan with
 * one task, exactly like any other single-source question, and a request that
 * needs both research *and* an image needs no special case at all.
 *
 * The tool returns an `ArtifactRef`. Image bytes are written to disk and
 * referenced — never inlined into evidence or an answer, which would blow the
 * context budget and put base64 in the trace.
 */

export interface ImageGenerationConfig {
  /** OpenAI-compatible `/v1/images/generations` endpoint. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Where artifacts are written. Defaults to `<workspace>/.codali/artifacts`. */
  artifactDir?: string;
  timeoutMs?: number;
  size?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_SIZE = "512x512";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Extracts image bytes from an OpenAI-compatible response. Servers return
 * either `b64_json` or a `url`; both shapes are handled because local
 * stable-diffusion servers and hosted APIs differ here.
 */
const readImagePayload = (
  payload: unknown,
): { b64?: string; url?: string } | undefined => {
  if (!isRecord(payload)) return undefined;
  const data = payload.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (!isRecord(first)) return undefined;
  const b64 = typeof first.b64_json === "string" ? first.b64_json : undefined;
  const url = typeof first.url === "string" ? first.url : undefined;
  return b64 || url ? { b64, url } : undefined;
};

export interface ImageToolOptions {
  config: ImageGenerationConfig;
  workspaceRoot: string;
  runId?: string;
  fetchImpl?: typeof fetch;
  /** Called for each artifact so the gateway can surface it in the result. */
  onArtifact?: (artifact: {
    id: string;
    type: string;
    path: string;
    mimeType: string;
    model: string;
    prompt: string;
  }) => void;
}

export const IMAGE_TOOL_NAME = "media_generate_image";

export const createImageGenerationTool = (options: ImageToolOptions): ToolDefinition => {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: IMAGE_TOOL_NAME,
    description:
      "Generate an image from a text prompt. Returns the path to the written image file, not the image itself. Use for any request to draw, render, or generate a picture.",
    capability: "media",
    // Generation writes a file, but only inside the run's own artifact
    // directory — it cannot touch the workspace or anything the user owns.
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1 },
        size: { type: "string" },
      },
    },
    handler: async (args) => {
      const record = isRecord(args) ? args : {};
      const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
      if (!prompt) {
        throw new ToolExecutionError("tool_invalid_args", "An image prompt is required.", {
          retryable: false,
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );

      let response: Response;
      try {
        response = await fetchImpl(
          new URL("images/generations", config.baseUrl.endsWith("/")
            ? config.baseUrl
            : `${config.baseUrl}/`).toString(),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: config.model,
              prompt,
              n: 1,
              size: typeof record.size === "string" ? record.size : (config.size ?? DEFAULT_SIZE),
              response_format: "b64_json",
            }),
            signal: controller.signal,
          },
        );
      } catch (error) {
        throw new ToolExecutionError(
          "tool_execution_failed",
          `Image generation request failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { retryable: true },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new ToolExecutionError(
          "tool_execution_failed",
          `Image generation returned HTTP ${response.status}.`,
          { retryable: response.status >= 500, details: { status: response.status } },
        );
      }

      const payload = await response.json();
      const image = readImagePayload(payload);
      if (!image) {
        throw new ToolExecutionError(
          "tool_execution_failed",
          "Image generation returned no image data.",
          { retryable: false },
        );
      }

      let bytes: Buffer;
      if (image.b64) {
        bytes = Buffer.from(image.b64, "base64");
      } else {
        const fetched = await fetchImpl(image.url as string);
        if (!fetched.ok) {
          throw new ToolExecutionError(
            "tool_execution_failed",
            `Could not download the generated image (HTTP ${fetched.status}).`,
            { retryable: true },
          );
        }
        bytes = Buffer.from(await fetched.arrayBuffer());
      }

      const artifactDir =
        config.artifactDir ??
        path.join(options.workspaceRoot, ".codali", "artifacts", options.runId ?? "run");
      await mkdir(artifactDir, { recursive: true });

      const id = `img-${randomUUID()}`;
      const filePath = path.join(artifactDir, `${id}.png`);
      await writeFile(filePath, bytes);

      options.onArtifact?.({
        id,
        type: "image",
        path: filePath,
        mimeType: "image/png",
        model: config.model,
        prompt,
      });

      return {
        // The path, not the bytes: inlining base64 would blow the context
        // budget and put megabytes of noise in the trace.
        output: `Generated an image and wrote it to ${filePath}`,
        data: { artifactId: id, path: filePath, mimeType: "image/png", prompt },
      };
    },
  };
};
