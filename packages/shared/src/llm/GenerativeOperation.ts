export const GENERATIVE_OPERATIONS = [
  "chat.completions",
  "images.generations",
  "audio.generations",
  "videos.generations",
] as const;

export type GenerativeOperation = (typeof GENERATIVE_OPERATIONS)[number];

export const GENERATIVE_MODALITIES = ["text", "image", "audio", "video"] as const;

export type GenerativeModality = (typeof GENERATIVE_MODALITIES)[number];

export type GenerativeOperationPath = `/${string}`;
export type GenerativeOperationMethod = "POST";

export const GENERATIVE_OPERATION_DEFAULT_PATHS: Readonly<
  Record<GenerativeOperation, GenerativeOperationPath>
> = {
  "chat.completions": "/v1/chat/completions",
  "images.generations": "/v1/images/generations",
  "audio.generations": "/v1/audio/generations",
  "videos.generations": "/v1/videos/generations",
};

export const GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS = {
  "chat.completions": [
    "model",
    "messages",
    "stream",
    "temperature",
    "top_p",
    "max_tokens",
    "stop",
    "response_format",
    "tools",
    "tool_choice",
  ],
  "images.generations": [
    "model",
    "prompt",
    "n",
    "size",
    "response_format",
    "seed",
    "steps",
    "negative_prompt",
  ],
  "audio.generations": [
    "model",
    "prompt",
    "duration_seconds",
    "response_format",
    "n",
    "seed",
    "steps",
    "negative_prompt",
    "sample_rate",
  ],
  "videos.generations": [
    "model",
    "prompt",
    "duration_seconds",
    "fps",
    "video_frames",
    "response_format",
    "n",
    "size",
    "seed",
    "steps",
    "high_noise_steps",
    "negative_prompt",
  ],
} as const satisfies Record<GenerativeOperation, readonly string[]>;

export type GenerativeRequestParameterByOperation = {
  [Operation in GenerativeOperation]:
    (typeof GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS)[Operation][number];
};

export type GenerativeRequestParameter<
  Operation extends GenerativeOperation = GenerativeOperation,
> = GenerativeRequestParameterByOperation[Operation];

export type GenerativeRequestParameterAllowlist<
  Operation extends GenerativeOperation = GenerativeOperation,
> = readonly GenerativeRequestParameter<Operation>[];

export const GENERATIVE_OPERATION_LIMIT_KEYS = [
  "maxRequestBytes",
  "maxOutputBytes",
  "maxPromptChars",
  "maxNegativePromptChars",
  "maxN",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "maxPixels",
  "minDurationSeconds",
  "maxDurationSeconds",
  "maxSampleRate",
  "minFps",
  "maxFps",
  "minVideoFrames",
  "maxVideoFrames",
  "maxSteps",
  "maxHighNoiseSteps",
] as const;

export type GenerativeOperationLimitKey = (typeof GENERATIVE_OPERATION_LIMIT_KEYS)[number];

export interface GenerativeOperationLimits {
  maxRequestBytes?: number;
  maxOutputBytes?: number;
  maxPromptChars?: number;
  maxNegativePromptChars?: number;
  maxN?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  maxPixels?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxSampleRate?: number;
  minFps?: number;
  maxFps?: number;
  minVideoFrames?: number;
  maxVideoFrames?: number;
  maxSteps?: number;
  maxHighNoiseSteps?: number;
}

export interface SelfHostedGenerativeOperation<
  Operation extends GenerativeOperation = GenerativeOperation,
> {
  operation: Operation;
  path: GenerativeOperationPath;
  method?: GenerativeOperationMethod;
  requestParameterAllowlist?: GenerativeRequestParameterAllowlist<Operation>;
  responseFormats?: readonly string[];
  outputMimeTypes?: readonly string[];
  limits?: GenerativeOperationLimits;
}

export type GenerativeOperationDescriptor<
  Operation extends GenerativeOperation = GenerativeOperation,
> = SelfHostedGenerativeOperation<Operation>;

const OPERATION_ALIASES: Readonly<Record<string, GenerativeOperation>> = {
  chat: "chat.completions",
  "chat.completion": "chat.completions",
  "chat.completions": "chat.completions",
  "chat-completion": "chat.completions",
  "chat-completions": "chat.completions",
  "/v1/chat/completions": "chat.completions",
  image: "images.generations",
  images: "images.generations",
  "image.generation": "images.generations",
  "image.generations": "images.generations",
  "images.generation": "images.generations",
  "images.generations": "images.generations",
  "image-generation": "images.generations",
  "image-generations": "images.generations",
  "/v1/images/generations": "images.generations",
  audio: "audio.generations",
  "audio.generation": "audio.generations",
  "audio.generations": "audio.generations",
  "audio-generation": "audio.generations",
  "audio-generations": "audio.generations",
  "/v1/audio/generations": "audio.generations",
  video: "videos.generations",
  videos: "videos.generations",
  "video.generation": "videos.generations",
  "videos.generation": "videos.generations",
  "videos.generations": "videos.generations",
  "video-generation": "videos.generations",
  "video-generations": "videos.generations",
  "/v1/video/generations": "videos.generations",
  "/v1/videos/generations": "videos.generations",
};

const MODALITY_ALIASES: Readonly<Record<string, GenerativeModality>> = {
  text: "text",
  chat: "text",
  image: "image",
  images: "image",
  audio: "audio",
  video: "video",
  videos: "video",
};

const REQUEST_PARAMETER_SETS: Readonly<Record<GenerativeOperation, ReadonlySet<string>>> = {
  "chat.completions": new Set(GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS["chat.completions"]),
  "images.generations": new Set(GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS["images.generations"]),
  "audio.generations": new Set(GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS["audio.generations"]),
  "videos.generations": new Set(GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS["videos.generations"]),
};

const LIMIT_KEY_SET = new Set<string>(GENERATIVE_OPERATION_LIMIT_KEYS);
const STRICT_ORIGIN_RELATIVE_PATH =
  /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const MAX_OPERATION_PATH_LENGTH = 2048;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNormalizedLookupKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

export function normalizeGenerativeOperation(value: unknown): GenerativeOperation | undefined {
  const normalized = asNormalizedLookupKey(value);
  return normalized ? OPERATION_ALIASES[normalized] : undefined;
}

export function normalizeGenerativeModality(value: unknown): GenerativeModality | undefined {
  const normalized = asNormalizedLookupKey(value);
  return normalized ? MODALITY_ALIASES[normalized] : undefined;
}

export function normalizeGenerativeModalities(
  value: unknown,
): GenerativeModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: GenerativeModality[] = [];
  for (const item of value) {
    const modality = normalizeGenerativeModality(item);
    if (modality && !normalized.includes(modality)) {
      normalized.push(modality);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function isGenerativeOperationPath(value: unknown): value is GenerativeOperationPath {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_OPERATION_PATH_LENGTH
    || value.trim() !== value
    || !STRICT_ORIGIN_RELATIVE_PATH.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .slice(1)
    .every((segment) => segment !== "." && segment !== "..");
}

export function normalizeGenerativeOperationPath(
  value: unknown,
): GenerativeOperationPath | undefined {
  return isGenerativeOperationPath(value) ? value : undefined;
}

const normalizeRequestParameterAllowlist = <
  Operation extends GenerativeOperation,
>(
  operation: Operation,
  value: unknown,
): GenerativeRequestParameter<Operation>[] => {
  const defaults = GENERATIVE_REQUEST_PARAMETER_ALLOWLISTS[operation] as readonly string[];
  if (value === undefined) {
    return [...defaults] as GenerativeRequestParameter<Operation>[];
  }
  if (!Array.isArray(value)) return [];

  const allowed = REQUEST_PARAMETER_SETS[operation];
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const parameter = item.trim();
    if (allowed.has(parameter) && !normalized.includes(parameter)) {
      normalized.push(parameter);
    }
  }
  return normalized as GenerativeRequestParameter<Operation>[];
};

const normalizeStringList = (
  value: unknown,
  normalize: (item: string) => string | undefined,
): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const candidate = normalize(item);
    if (candidate && !normalized.includes(candidate)) {
      normalized.push(candidate);
    }
  }
  return normalized;
};

const normalizeResponseFormat = (value: string): string | undefined => {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(normalized) ? normalized : undefined;
};

const normalizeMimeType = (value: string): string | undefined => {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
    normalized,
  )
    ? normalized
    : undefined;
};

const normalizeGenerativeOperationLimits = (
  value: unknown,
): GenerativeOperationLimits | undefined => {
  if (!isRecord(value)) return undefined;
  const normalized: Partial<Record<GenerativeOperationLimitKey, number>> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      LIMIT_KEY_SET.has(key)
      && typeof candidate === "number"
      && Number.isSafeInteger(candidate)
      && candidate > 0
    ) {
      normalized[key as GenerativeOperationLimitKey] = candidate;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const normalizeOperationMethod = (
  value: unknown,
): GenerativeOperationMethod | undefined => {
  if (value === undefined) return "POST";
  return typeof value === "string" && value.trim().toUpperCase() === "POST"
    ? "POST"
    : undefined;
};

export function normalizeSelfHostedGenerativeOperation(
  value: unknown,
): SelfHostedGenerativeOperation | undefined {
  const record = isRecord(value) ? value : undefined;
  const operation = normalizeGenerativeOperation(record ? record.operation : value);
  if (!operation) return undefined;

  const method = normalizeOperationMethod(record?.method);
  if (!method) return undefined;

  const path = record && record.path !== undefined
    ? normalizeGenerativeOperationPath(record.path)
    : GENERATIVE_OPERATION_DEFAULT_PATHS[operation];
  if (!path) return undefined;

  const normalized: SelfHostedGenerativeOperation = {
    operation,
    path,
    method,
    requestParameterAllowlist: normalizeRequestParameterAllowlist(
      operation,
      record?.requestParameterAllowlist,
    ),
  };

  const responseFormats = normalizeStringList(
    record?.responseFormats,
    normalizeResponseFormat,
  );
  if (responseFormats !== undefined) {
    normalized.responseFormats = responseFormats;
  }

  const outputMimeTypes = normalizeStringList(
    record?.outputMimeTypes,
    normalizeMimeType,
  );
  if (outputMimeTypes !== undefined) {
    normalized.outputMimeTypes = outputMimeTypes;
  }

  const limits = normalizeGenerativeOperationLimits(record?.limits);
  if (limits) {
    normalized.limits = limits;
  }

  return normalized;
}
