import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildInstallSetupArgs, buildSelfHostedNodeApp, isSelfHostedNodeDirectRun, normalizeMswarmCommand } from "../server.js";
import {
  MswarmCodaliExecutor,
  type MswarmCodaliInvocationInput,
  type MswarmCodaliInvocationResult
} from "../codali-executor.js";
import {
  type CommandRunner,
  type SelfHostedNodeConfig,
  McodaAgentInventoryClient,
  McodaLocalAgentExecutor,
  controlSelfHostedNodeService,
  installSelfHostedNodeService,
  machineFingerprintFromId,
  mapMcodaAgentToSelfHostedModel,
  mapOllamaModelToSelfHostedModel,
  readOrCreateSelfHostedMachineId,
  readOwnerSetupConfig,
  readSelfHostedNodeConfig,
  resolveSelfHostedNodeServiceLayout,
  uninstallSelfHostedNodeService,
  SelfHostedNodeRuntime
} from "../runtime.js";

function expect<T>(actual: T) {
  const not = {
    toContain(expected: unknown) {
      if (typeof actual === "string") {
        assert.equal(actual.includes(String(expected)), false);
        return;
      }
      assert.equal(Array.isArray(actual) && actual.includes(expected), false);
    }
  };
  return {
    not,
    toBe(expected: unknown) {
      assert.strictEqual(actual, expected);
    },
    toBeNull() {
      assert.strictEqual(actual, null);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined);
    },
    toContain(expected: unknown) {
      if (typeof actual === "string") {
        assert.match(actual, new RegExp(escapeRegExp(String(expected))));
        return;
      }
      assert.equal(Array.isArray(actual) && actual.includes(expected), true);
    },
    toEqual(expected: unknown) {
      assert.deepStrictEqual(actual, expected);
    },
    toHaveLength(expected: number) {
      assert.equal((actual as { length?: number } | null | undefined)?.length, expected);
    },
    toMatch(expected: RegExp) {
      assert.match(String(actual), expected);
    },
    toMatchObject(expected: Record<string, unknown>) {
      assertPartialObject(actual, expected);
    }
  };
}

function assertPartialObject(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual !== null && typeof actual === "object", "actual value is not an object");
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue: unknown = (actual as Record<string, unknown>)[key];
    if (
      expectedValue !== null &&
      typeof expectedValue === "object" &&
      !Array.isArray(expectedValue) &&
      !(expectedValue instanceof RegExp)
    ) {
      assertPartialObject(actualValue, expectedValue as Record<string, unknown>);
    } else {
      assert.deepStrictEqual(actualValue, expectedValue);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteSystemdValueForTest(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const tempDirs: string[] = [];

function tempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mswarm-self-hosted-node-"));
  tempDirs.push(dir);
  return join(dir, "state.json");
}

function tempRuntimeTokenPath(statePath: string): string {
  return join(dirname(statePath), "node.key");
}

async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version || "";
}

function testLaunchdDomain(): string {
  return `gui/${userInfo().uid}`;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function serviceConfigFor(statePath: string): SelfHostedNodeConfig {
  return {
    gatewayBaseUrl: "https://gateway.test",
    nodeId: "shn_service",
    serverName: "service-box",
    relayMode: "outbound",
    machineFingerprint: `sha256:${"a".repeat(64)}`,
    directBaseUrl: null,
    enrollmentToken: null,
    runtimeToken: "runtime-token-should-not-be-written",
    discoveryMode: "mcoda",
    mcodaBin: "mcoda",
    mcodaListArgs: ["agent", "list", "--json", "--refresh-health"],
    ollamaBaseUrl: "http://ollama.test",
    statePath,
    runtimeTokenPath: tempRuntimeTokenPath(statePath),
    invocationSigningSecret: "signing-secret-should-not-be-written",
    listenHost: "127.0.0.1",
    listenPort: 18083,
    nodeVersion: "test-node",
    heartbeatIntervalSeconds: 30,
    requestTimeoutMs: 1000,
    jobTimeoutMs: 3_600_000,
    exposeAllModels: true,
    modelAllowlist: ["phi3-reviewer"],
    modelBlocklist: ["nomic-embed-text:latest"]
  };
}

function permissiveServiceConfigFor(statePath: string): SelfHostedNodeConfig {
  return {
    ...serviceConfigFor(statePath),
    modelAllowlist: []
  };
}

function mcodaAgentListClient(agents: unknown[]): McodaAgentInventoryClient {
  return new McodaAgentInventoryClient({
    runner: async () => ({
      stdout: JSON.stringify(agents),
      stderr: ""
    })
  });
}

function healthyMcodaAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "qwen-reviewer",
    adapter: "ollama-remote",
    defaultModel: "qwen3.5:35b",
    supportsTools: true,
    contextWindow: 131_072,
    maxOutputTokens: 8192,
    capabilities: ["code_write", "code_review"],
    health: { status: "healthy" },
    config: {
      baseUrl: "http://ollama.test"
    },
    ...overrides
  };
}

function successfulCodaliInvocation(
  input: MswarmCodaliInvocationInput,
  output = "{\"decision\":\"approve\"}"
): MswarmCodaliInvocationResult {
  return {
    output,
    usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
    runtimeResult: {
      finalMessage: output,
      messages: [{ role: "assistant", content: output }],
      toolCallsExecuted: 0,
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
      touchedFiles: [],
      warnings: [],
      events: [],
      runId: `run-${input.requestId}`
    },
    openAIChunks: [],
    metadata: {
      provider: input.agent.provider || "ollama-remote",
      adapter: input.agent.adapter,
      local_model: input.agent.model,
      agent_slug: input.agent.slug,
      run_id: `run-${input.requestId}`,
      tool_calls_executed: 0,
      touched_files: [],
      warnings: [],
      mode: input.policy?.allowTools === false ? "freeform" : "tool_loop"
    }
  };
}

class StubCodaliExecutor extends MswarmCodaliExecutor {
  constructor(private readonly handler: (input: MswarmCodaliInvocationInput) => Promise<MswarmCodaliInvocationResult>) {
    super();
  }

  override async invoke(input: MswarmCodaliInvocationInput): Promise<MswarmCodaliInvocationResult> {
    return this.handler(input);
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signInvocationToken(input: {
  secret: string;
  nodeId: string;
  jobId: string;
  requestId: string;
  model: string;
}): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      node_id: input.nodeId,
      job_id: input.jobId,
      request_id: input.requestId,
      model: input.model,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      scope: "self_hosted.invoke",
      iat: now,
      exp: now + 60
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = base64Url(createHmac("sha256", input.secret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("self-hosted node runtime", () => {
  it("detects npm symlinked bin paths as direct runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "mswarm-self-hosted-node-bin-"));
    tempDirs.push(dir);
    const target = join(dir, "server.js");
    const bin = join(dir, "mswarm");
    writeFileSync(target, "", "utf8");
    symlinkSync(target, bin);

    expect(isSelfHostedNodeDirectRun(bin, pathToFileURL(target).href)).toBe(true);
  });

  it("maps Ollama model tags into self-hosted model metadata", () => {
    const mapped = mapOllamaModelToSelfHostedModel(
      {
        name: "phi3.5:3.8b",
        digest: "61819fb370a3",
        details: {
          family: "phi3",
          parameter_size: "3.8B",
          quantization_level: "Q4_0"
        }
      },
      {
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: []
      }
    );
    expect(mapped?.name).toBe("phi3.5:3.8b");
    expect(mapped?.family).toBe("phi3");
    expect(mapped?.parameter_size).toBe("3.8B");
    expect(mapped?.quantization_level).toBe("Q4_0");
    expect(mapped?.exposed).toBe(true);
    expect(mapped?.metadata_quality).toBe("discovered");
  });

  it("honors model allowlist and blocklist exposure rules", () => {
    const hidden = mapOllamaModelToSelfHostedModel(
      { name: "hidden:latest" },
      { exposeAllModels: true, modelAllowlist: ["visible:latest"], modelBlocklist: [] }
    );
    const blocked = mapOllamaModelToSelfHostedModel(
      { name: "visible:latest" },
      { exposeAllModels: true, modelAllowlist: [], modelBlocklist: ["visible:latest"] }
    );
    expect(hidden?.exposed).toBe(false);
    expect(blocked?.exposed).toBe(false);
  });

  it("keeps embedding-only Ollama models out of the exposed agent catalog", () => {
    const mapped = mapOllamaModelToSelfHostedModel(
      {
        name: "nomic-embed-text:latest",
        details: {
          family: "nomic-bert",
          parameter_size: "137M",
          quantization_level: "F16"
        }
      },
      {
        exposeAllModels: true,
        modelAllowlist: ["nomic-embed-text:latest"],
        modelBlocklist: []
      }
    );
    expect(mapped?.exposed).toBe(false);
    expect(mapped?.best_usage).toBe("embedding");
  });

  it("maps mcoda local agents into self-hosted agent metadata", () => {
    const mapped = mapMcodaAgentToSelfHostedModel(
      {
        id: "0170e0ba-c809-465a-848f-1338c00977f4",
        slug: "claude-sonnet",
        adapter: "claude-cli",
        defaultModel: "sonnet",
        contextWindow: 200000,
        maxOutputTokens: 64000,
        supportsTools: true,
        rating: 7.75,
        reasoningRating: 7.81,
        bestUsage: "code_write",
        costPerMillion: 15,
        maxComplexity: 7,
        capabilities: ["code_review", "code_write", "plan"],
        health: { status: "healthy" }
      },
      {
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: []
      }
    );
    expect(mapped?.name).toBe("claude-sonnet");
    expect(mapped?.provider).toBe("mcoda");
    expect(mapped?.adapter).toBe("claude-cli");
    expect(mapped?.source_agent_slug).toBe("claude-sonnet");
    expect(mapped?.model_id).toBe("sonnet");
    expect(mapped?.supports_tools).toBe(true);
    expect(mapped?.capabilities).toContain("code_write");
    expect(mapped?.cost_per_million).toBe(15);
    expect(mapped?.health_status).toBe("healthy");
  });

  it("preserves local OpenAI-compatible runner metadata in self-hosted agent catalog", () => {
    const mapped = mapMcodaAgentToSelfHostedModel(
      {
        id: "local-vllm-id",
        slug: "local-vllm-coder",
        adapter: "vllm-local",
        defaultModel: "Qwen/Qwen3-32B",
        openaiCompatible: true,
        contextWindow: 131_072,
        maxOutputTokens: 8192,
        supportsTools: true,
        rating: 8.1,
        reasoningRating: 7.9,
        bestUsage: "code_write",
        costPerMillion: 0,
        maxComplexity: 8,
        capabilities: ["code_write", "json_schema"],
        health: { status: "healthy" },
        config: {
          baseUrl: "http://127.0.0.1:8000/v1",
          authMode: "none",
          responseFormatStrategy: "json-object",
          healthPath: "/health",
          modelsPath: "/v1/models",
          supportsStreaming: true,
          supportsJsonSchema: true,
          supportsGbnf: false,
          apiKey: "secret-local-key"
        }
      },
      {
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: []
      }
    );

    expect(mapped?.name).toBe("local-vllm-coder");
    expect(mapped?.provider).toBe("mcoda");
    expect(mapped?.adapter).toBe("vllm-local");
    expect(mapped?.model).toBe("Qwen/Qwen3-32B");
    expect(mapped?.model_id).toBe("Qwen/Qwen3-32B");
    expect(mapped?.base_url).toBe("http://127.0.0.1:8000/v1");
    expect(mapped?.runner_kind).toBe("vllm");
    expect(mapped?.auth_mode).toBe("none");
    expect(mapped?.response_format_strategy).toBe("json-object");
    expect(mapped?.health_path).toBe("/health");
    expect(mapped?.models_path).toBe("/v1/models");
    expect(mapped?.supports_tools).toBe(true);
    expect(mapped?.supports_streaming).toBe(true);
    expect(mapped?.supports_json_schema).toBe(true);
    expect(mapped?.supports_gbnf).toBe(false);
    expect(mapped?.openai_compatible).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain("secret-local-key");
  });

  it("excludes managed mswarm cloud agents from self-hosted mcoda discovery", () => {
    const mapped = mapMcodaAgentToSelfHostedModel(
      {
        slug: "mswarm-cloud-openrouter-z-ai-glm-5",
        adapter: "openai-api",
        defaultModel: "z-ai/glm-5",
        config: {
          mswarmCloud: {
            managed: true
          }
        }
      },
      {
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: []
      }
    );
    expect(mapped).toBeNull();
  });

  it("loads config from env and persisted runtime state", async () => {
    const statePath = tempStatePath();
    const firstConfig = await readSelfHostedNodeConfig({
      MSWARM_SELF_HOSTED_NODE_ID: "shn_env",
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_MODEL_ALLOWLIST: "phi3.5:3.8b,llama3.1:8b",
      MSWARM_SELF_HOSTED_EXPOSURE_POLICY: "none"
    } as NodeJS.ProcessEnv);
    expect(firstConfig.nodeId).toBe("shn_env");
    expect(firstConfig.discoveryMode).toBe("mcoda");
    expect(firstConfig.mcodaBin).toBe("mcoda");
    expect(firstConfig.requestTimeoutMs).toBe(10_000);
    expect(firstConfig.jobTimeoutMs).toBe(3_600_000);
    expect(firstConfig.exposeAllModels).toBe(false);
    expect(firstConfig.modelAllowlist).toEqual(["phi3.5:3.8b", "llama3.1:8b"]);
  });

  it("keeps legacy request timeout state from limiting long local jobs", async () => {
    const statePath = tempStatePath();
    writeFileSync(
      statePath,
      JSON.stringify({
        node_id: "shn_legacy_timeout",
        gateway_base_url: "https://gateway.test",
        request_timeout_ms: 10_000
      }),
      "utf8"
    );

    const config = await readSelfHostedNodeConfig({
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath)
    } as NodeJS.ProcessEnv);

    expect(config.requestTimeoutMs).toBe(10_000);
    expect(config.jobTimeoutMs).toBe(3_600_000);
  });

  it("honors explicit self-hosted job timeout overrides", async () => {
    const statePath = tempStatePath();
    const config = await readSelfHostedNodeConfig({
      MSWARM_SELF_HOSTED_NODE_ID: "shn_job_timeout",
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_JOB_TIMEOUT_MS: "7200000"
    } as NodeJS.ProcessEnv);

    expect(config.jobTimeoutMs).toBe(7_200_000);
  });

  it("migrates legacy daemon exposure false to the new exposed-by-default policy", async () => {
    const statePath = tempStatePath();
    writeFileSync(
      statePath,
      JSON.stringify({
        node_id: "shn_legacy",
        expose_all_models: false,
        gateway_base_url: "https://gateway.test"
      }),
      "utf8"
    );

    const config = await readSelfHostedNodeConfig({
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath),
      MSWARM_SELF_HOSTED_EXPOSE_ALL_MODELS: "false"
    } as NodeJS.ProcessEnv);

    expect(config.exposeAllModels).toBe(true);
  });

  it("honors explicit daemon exposure opt-out policy", async () => {
    const statePath = tempStatePath();
    writeFileSync(
      statePath,
      JSON.stringify({
        node_id: "shn_policy_none",
        expose_all_models: true,
        exposure_policy: "none",
        gateway_base_url: "https://gateway.test"
      }),
      "utf8"
    );

    const config = await readSelfHostedNodeConfig({
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath)
    } as NodeJS.ProcessEnv);

    expect(config.exposeAllModels).toBe(false);
  });

  it("parses owner setup config and derives a stable local machine fingerprint", async () => {
    const statePath = tempStatePath();
    const machinePath = join(dirname(statePath), "machine.id");
    const setupConfig = await readOwnerSetupConfig(
      [
        "--api-key",
        "msw_owner",
        "--gateway",
        "https://gateway.test/",
        "--server-name",
        "Bekir MacBook Pro",
        "--allow",
        "phi3-reviewer"
      ],
      {
        MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
        MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath),
        MSWARM_SELF_HOSTED_MACHINE_ID_PATH: machinePath
      } as NodeJS.ProcessEnv
    );
    expect(setupConfig.gatewayBaseUrl).toBe("https://gateway.test");
    expect(setupConfig.serverName).toBe("bekir-macbook-pro");
    expect(setupConfig.relayMode).toBe("outbound");
    expect(setupConfig.jobTimeoutMs).toBe(3_600_000);
    expect(setupConfig.exposeAllModels).toBe(true);
    expect(setupConfig.modelAllowlist).toEqual(["phi3-reviewer"]);

    const firstMachineId = await readOrCreateSelfHostedMachineId(machinePath);
    const secondMachineId = await readOrCreateSelfHostedMachineId(machinePath);
    expect(secondMachineId).toBe(firstMachineId);
    expect(machineFingerprintFromId(firstMachineId)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("parses owner setup exposure opt-out", async () => {
    const statePath = tempStatePath();
    const setupConfig = await readOwnerSetupConfig(
      ["--api-key", "msw_owner", "--no-expose-all"],
      {
        MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
        MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath),
        MSWARM_SELF_HOSTED_MACHINE_ID_PATH: join(dirname(statePath), "machine.id")
      } as NodeJS.ProcessEnv
    );

    expect(setupConfig.exposeAllModels).toBe(false);
  });

  it("parses install positional API key without requiring an exported shell key", async () => {
    const statePath = tempStatePath();
    const machinePath = join(dirname(statePath), "machine.id");
    const setupArgs = buildInstallSetupArgs([
      "msw_owner",
      "--gateway",
      "https://gateway.test/",
      "--server-name",
      "Bekir MacBook Pro"
    ]);

    expect(setupArgs.slice(0, 2)).toEqual(["--api-key", "msw_owner"]);
    const setupConfig = await readOwnerSetupConfig(setupArgs, {
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath),
      MSWARM_SELF_HOSTED_MACHINE_ID_PATH: machinePath
    } as NodeJS.ProcessEnv);

    expect(setupConfig.apiKey).toBe("msw_owner");
    expect(setupConfig.gatewayBaseUrl).toBe("https://gateway.test");
    expect(setupConfig.serverName).toBe("bekir-macbook-pro");
    expect(setupConfig.exposeAllModels).toBe(true);
  });

  it("uses one hour as the default mcoda job execution timeout", async () => {
    let timeoutMs = 0;
    let stdin = "";
    const executor = new McodaLocalAgentExecutor({
      runner: async (_command, _args, options) => {
        timeoutMs = options.timeoutMs || 0;
        stdin = options.input || "";
        return {
          stdout: JSON.stringify({ responses: [{ output: "pong" }] }),
          stderr: ""
        };
      }
    });

    const result = await executor.invoke("codex-agent", "ping");

    expect(result.output).toBe("pong");
    expect(timeoutMs).toBe(3_600_000);
    expect(stdin).toBe("ping");
  });

  it("passes JSON response format to Ollama invocation jobs", async () => {
    const statePath = tempStatePath();
    let chatBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "http://ollama.test/api/chat") {
        chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          message: { content: "{\"decision\":\"approve\"}" },
          prompt_eval_count: 9,
          eval_count: 4
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(serviceConfigFor(statePath), { fetchImpl });

    const result = await runtime.executeJob({
      job_id: "job-json",
      request_id: "req-json",
      node_id: "shn_service",
      agent_slug: "phi3-reviewer",
      provider: "ollama",
      model: "phi3.5:latest",
      openai_request: {
        model: "phi3.5:latest",
        messages: [{ role: "user", content: "Return a decision object." }],
        response_format: { type: "json_object" }
      }
    });

    expect(result.status).toBe("success");
    assert.ok(chatBody);
    expect((chatBody as Record<string, unknown>).format).toBe("json");
    expect((chatBody as Record<string, unknown>).stream).toBe(false);
  });

  it("routes mcoda invocation jobs through Codali with agent metadata and response format", async () => {
    const statePath = tempStatePath();
    const captured: { value?: MswarmCodaliInvocationInput } = {};
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        captured.value = input;
        return successfulCodaliInvocation(input);
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-mcoda-json",
      request_id: "req-mcoda-json",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "Review this log." }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "review_decision",
            schema: {
              type: "object",
              required: ["decision"],
              properties: { decision: { type: "string" } }
            }
          }
        }
      }
    });

    expect(result.status).toBe("success");
    const capturedInput = captured.value;
    assert.ok(capturedInput);
    expect(capturedInput.agent.slug).toBe("qwen-reviewer");
    expect(capturedInput.agent.adapter).toBe("ollama-remote");
    expect(capturedInput.agent.model).toBe("qwen3.5:35b");
    expect(capturedInput.agent.baseUrl).toBe("http://ollama.test");
    expect(capturedInput.policy?.allowTools).toBe(true);
    expect(capturedInput.responseFormat?.type).toBe("json_schema");
    expect(capturedInput.messages[0]?.content).toBe("Review this log.");
    expect((result.openai_response?.choices as Array<{ message?: { content?: string } }>)[0]?.message?.content).toBe(
      "{\"decision\":\"approve\"}"
    );
    expect(((result.openai_response?.metadata as Record<string, unknown>) || {}).codali_run_id).toBe("run-req-mcoda-json");
  });

  it("normalizes Ollama CLI mcoda agents to the Codali Ollama provider", async () => {
    const statePath = tempStatePath();
    const captured: { value?: MswarmCodaliInvocationInput } = {};
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          adapter: "ollama-cli",
          supportsTools: false,
          config: {}
        })
      ]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        captured.value = input;
        return successfulCodaliInvocation(input);
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-mcoda-ollama-cli",
      request_id: "req-mcoda-ollama-cli",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "Search encrypted Docdex context." }]
      },
      policy: {
        allow_tools: true,
        allowed_tools: ["docdex_search"]
      }
    });

    expect(result.status).toBe("success");
    const capturedInput = captured.value;
    assert.ok(capturedInput);
    expect(capturedInput.agent.adapter).toBe("ollama-cli");
    expect(capturedInput.agent.provider).toBe("ollama-remote");
    expect(capturedInput.agent.supportsTools).toBe(false);
  });

  it("routes local OpenAI-compatible mcoda agents to Codali with runner metadata", async () => {
    const cases = [
      { adapter: "vllm-local", runnerKind: "vllm" },
      { adapter: "llama-cpp-local", runnerKind: "llama-cpp" },
      { adapter: "llamacpp-local", runnerKind: "llama-cpp" }
    ];

    for (const testCase of cases) {
      const statePath = tempStatePath();
      const captured: { value?: MswarmCodaliInvocationInput } = {};
      const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
        mcoda: mcodaAgentListClient([
          healthyMcodaAgent({
            slug: `${testCase.adapter}-agent`,
            adapter: testCase.adapter,
            defaultModel: "Qwen/Qwen3-32B",
            openaiCompatible: true,
            supportsTools: true,
            capabilities: ["code_write", "json_schema"],
            config: {
              baseUrl: "http://127.0.0.1:8000/v1",
              authMode: "dummy-bearer",
              dummyBearerToken: "local",
              headers: { "x-mswarm-node": "local" },
              extraBody: { guided_choice: ["approve", "reject"] },
              responseFormatStrategy: "json-object",
              healthPath: "/health",
              modelsPath: "/v1/models",
              supportsStreaming: true,
              supportsJsonSchema: true
            }
          })
        ]),
        codaliExecutor: new StubCodaliExecutor(async (input) => {
          captured.value = input;
          return successfulCodaliInvocation(input);
        })
      });

      const result = await runtime.executeJob({
        job_id: `job-${testCase.adapter}`,
        request_id: `req-${testCase.adapter}`,
        node_id: "shn_service",
        agent_slug: `${testCase.adapter}-agent`,
        source_agent_slug: `${testCase.adapter}-agent`,
        provider: "mcoda",
        model: `mcoda-${testCase.adapter}-agent`,
        openai_request: {
          model: `mcoda-${testCase.adapter}-agent`,
          messages: [{ role: "user", content: "Use the local runner." }]
        },
        policy: {
          allow_tools: true,
          allowed_tools: ["docdex_search"]
        }
      });

      expect(result.status).toBe("success");
      const capturedInput = captured.value;
      assert.ok(capturedInput);
      expect(capturedInput.agent.adapter).toBe(testCase.adapter);
      expect(capturedInput.agent.provider).toBe("openai-compatible");
      expect(capturedInput.agent.model).toBe("Qwen/Qwen3-32B");
      expect(capturedInput.agent.baseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(capturedInput.agent.localRunner?.baseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(capturedInput.agent.runnerKind).toBe(testCase.runnerKind);
      expect(capturedInput.agent.authMode).toBe("dummy-bearer");
      expect(capturedInput.agent.dummyBearerToken).toBe("local");
      expect(capturedInput.agent.headers).toEqual({ "x-mswarm-node": "local" });
      expect(capturedInput.agent.extraBody).toEqual({ guided_choice: ["approve", "reject"] });
      expect(capturedInput.agent.responseFormatStrategy).toBe("json-object");
      expect(capturedInput.agent.healthPath).toBe("/health");
      expect(capturedInput.agent.modelsPath).toBe("/v1/models");
      expect(capturedInput.agent.supportsStreaming).toBe(true);
      expect(capturedInput.agent.supportsTools).toBe(true);
      expect(capturedInput.agent.supportsJsonSchema).toBe(true);
    }
  });

  it("passes encrypted Docdex job context and attached mswarm API key to Codali without response leakage", async () => {
    const statePath = tempStatePath();
    const secret = "msw_docdex_secret";
    const captured: { value?: MswarmCodaliInvocationInput } = {};
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          config: {
            baseUrl: "http://ollama.test"
          }
        })
      ]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        captured.value = input;
        return successfulCodaliInvocation(input);
      })
    });

    const result = await runtime.executeJob(
      {
        job_id: "job-docdex-secure",
        request_id: "req-docdex-secure",
        node_id: "shn_service",
        agent_slug: "qwen-reviewer",
        source_agent_slug: "qwen-reviewer",
        provider: "mcoda",
        model: "mcoda-qwen-reviewer",
        workspace: { root: "/tmp/secure-workspace", read_only: true },
        docdex: {
          base_url: "http://docdex.secure.test",
          repo_id: "repo-secure",
          required: true,
          credential_source: "attached_mswarm_api_key",
          allowed_operations: ["search", "snippet"],
          capabilities: { search: true, snippet: true, open: false },
          allow_web: false,
          allow_memory_write: false,
          allow_profile_write: false,
          allow_index_rebuild: false
        },
        policy: {
          allowed_tools: ["docdex_search", "docdex_open"],
          allow_shell: false,
          allow_writes: false
        },
        openai_request: {
          model: "mcoda-qwen-reviewer",
          messages: [{ role: "user", content: "Use encrypted Docdex search." }]
        }
      },
      {
        attachedMswarmApiKey: secret
      },
    );

    expect(result.status).toBe("success");
    const capturedInput = captured.value;
    assert.ok(capturedInput);
    expect(capturedInput.docdex?.baseUrl).toBe("http://docdex.secure.test");
    expect(capturedInput.docdex?.repoId).toBe("repo-secure");
    expect(capturedInput.docdex?.credentialSource).toBe("attached_mswarm_api_key");
    expect(capturedInput.docdex?.required).toBe(true);
    expect(capturedInput.docdex?.allowedOperations).toEqual(["search", "snippet"]);
    expect(capturedInput.docdex?.capabilities).toEqual({ search: true, snippet: true, open: false });
    expect(capturedInput.attachedMswarmApiKey).toBe(secret);
    expect(JSON.stringify(result.openai_response)).not.toContain(secret);
    expect(JSON.stringify(result.progress_events || [])).not.toContain(secret);
  });

  it("uses the ephemeral relay poll attachment for encrypted Docdex jobs", async () => {
    const statePath = tempStatePath();
    const secret = "msw_relay_docdex_secret";
    const captured: { value?: MswarmCodaliInvocationInput } = {};
    let postedResult: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/poll") {
        return jsonResponse({
          attached_mswarm_api_key: secret,
          job: {
            job_id: "job-docdex-relay",
            request_id: "req-docdex-relay",
            node_id: "shn_service",
            agent_slug: "qwen-reviewer",
            source_agent_slug: "qwen-reviewer",
            provider: "mcoda",
            model: "mcoda-qwen-reviewer",
            docdex: {
              base_url: "http://docdex.secure.test",
              repo_id: "repo-secure",
              required: true,
              credential_source: "attached_mswarm_api_key",
              allowed_operations: ["search", "snippet"]
            },
            openai_request: {
              model: "mcoda-qwen-reviewer",
              messages: [{ role: "user", content: "Use relay Docdex search." }]
            }
          }
        });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-docdex-relay/result") {
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      fetchImpl,
      mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        captured.value = input;
        return successfulCodaliInvocation(input);
      })
    });

    const result = await runtime.pollAndExecuteJob(1);

    expect(result.executed).toBe(true);
    expect(result.status).toBe("success");
    assert.ok(captured.value);
    expect(captured.value.attachedMswarmApiKey).toBe(secret);
    expect(captured.value.docdex?.credentialSource).toBe("attached_mswarm_api_key");
    assert.ok(postedResult);
    expect(JSON.stringify(postedResult)).not.toContain(secret);
  });

  it("posts outbound relay stream events while executing streamed jobs", async () => {
    const statePath = tempStatePath();
    const eventPosts: Record<string, unknown>[] = [];
    let postedResult: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/poll") {
        return jsonResponse({
          job: {
            job_id: "job-stream-relay",
            request_id: "req-stream-relay",
            node_id: "shn_service",
            agent_slug: "qwen-reviewer",
            source_agent_slug: "qwen-reviewer",
            provider: "mcoda",
            model: "mcoda-qwen-reviewer",
            openai_request: {
              model: "mcoda-qwen-reviewer",
              stream: true,
              messages: [{ role: "user", content: "Stream this." }]
            }
          }
        });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-stream-relay/events") {
        eventPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ accepted: true });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-stream-relay/result") {
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      fetchImpl,
      mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        await input.onOpenAIChunk?.({
          id: "chatcmpl-req-stream-relay",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "hel" }, finish_reason: null }]
        });
        await input.onOpenAIChunk?.({
          id: "chatcmpl-req-stream-relay",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }]
        });
        await input.onOpenAIChunk?.({
          id: "chatcmpl-req-stream-relay",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        });
        return successfulCodaliInvocation(input, "hello");
      })
    });

    const result = await runtime.pollAndExecuteJob(1);

    expect(result.executed).toBe(true);
    expect(result.status).toBe("success");
    expect(eventPosts).toHaveLength(1);
    assert.ok(eventPosts[0]);
    expect((eventPosts[0].stream_events as unknown[] | undefined)?.length).toBe(3);
    assert.ok(postedResult);
    expect((postedResult as { stream_events?: unknown[] }).stream_events).toBeUndefined();
  });

  it("fails required encrypted Docdex jobs when the attached mswarm API key is unavailable", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          config: {
            baseUrl: "http://ollama.test",
            apiKey: "provider-local-key-is-not-docdex-key"
          }
        })
      ]),
      codaliExecutor: new StubCodaliExecutor(async (input) => successfulCodaliInvocation(input))
    });

    const result = await runtime.executeJob({
      job_id: "job-docdex-missing-key",
      request_id: "req-docdex-missing-key",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      docdex: {
        base_url: "http://docdex.secure.test",
        repo_id: "repo-secure",
        required: true,
        credential_source: "attached_mswarm_api_key",
        allowed_operations: ["search"]
      },
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "Use encrypted Docdex search." }]
      }
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("docdex_api_key_missing");
    expect(JSON.stringify(result)).not.toContain("provider-local-key-is-not-docdex-key");
  });

  it("maps Codali policy denials to self-hosted job failures", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
      codaliExecutor: new StubCodaliExecutor(async () => {
        throw new Error("policy denied: docdex_memory_save is not allowed");
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-policy",
      request_id: "req-policy",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "Save this memory." }]
      }
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("policy_denied");
  });

  it("maps Codali timeout failures to self-hosted job failures", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
      codaliExecutor: new StubCodaliExecutor(async () => {
        throw new Error("runner timeout exceeded");
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-timeout",
      request_id: "req-timeout",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "Write a large app." }]
      }
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("timeout");
  });

  it("preserves OpenAI-compatible stream chunks from Codali jobs", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        await input.onOpenAIChunk?.({
          id: "chatcmpl-req-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta: { content: "<canvas>" }, finish_reason: null }]
        });
        await input.onOpenAIChunk?.({
          id: "chatcmpl-req-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        });
        return successfulCodaliInvocation(input, "<canvas></canvas>");
      })
    });

    const emitted: Record<string, unknown>[] = [];
    const result = await runtime.executeJob(
      {
        job_id: "job-stream",
        request_id: "req-stream",
        node_id: "shn_service",
        agent_slug: "qwen-reviewer",
        source_agent_slug: "qwen-reviewer",
        provider: "mcoda",
        model: "mcoda-qwen-reviewer",
        openai_request: {
          model: "mcoda-qwen-reviewer",
          stream: true,
          messages: [{ role: "user", content: "Write ping pong HTML." }]
        }
      },
      {
        onOpenAIChunk: async (chunk) => {
          emitted.push(chunk);
        }
      }
    );

    expect(result.status).toBe("success");
    expect(result.stream_events?.length).toBe(2);
    expect(emitted.length).toBe(2);
    expect(
      (emitted[0]?.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content
    ).toBe("<canvas>");
  });

  it("serves direct stream jobs as OpenAI-compatible SSE", async () => {
    const statePath = tempStatePath();
    const config = serviceConfigFor(statePath);
    const job = {
      job_id: "job-sse",
      request_id: "req-sse",
      node_id: config.nodeId,
      agent_slug: "qwen-reviewer",
      provider: "mcoda" as const,
      model: "mcoda-qwen-reviewer",
      openai_request: {
        model: "mcoda-qwen-reviewer",
        stream: true,
        messages: [{ role: "user", content: "Write ping pong HTML." }]
      }
    };
    let capturedAttachedMswarmApiKey: string | undefined;
    const runtime = {
      executeJob: async (
        _job: unknown,
        options?: {
          onOpenAIChunk?: (chunk: Record<string, unknown>) => void | Promise<void>;
          attachedMswarmApiKey?: string;
        }
      ) => {
        capturedAttachedMswarmApiKey = options?.attachedMswarmApiKey;
        await options?.onOpenAIChunk?.({
          id: "chatcmpl-req-sse",
          object: "chat.completion.chunk",
          created: 1,
          model: "mcoda-qwen-reviewer",
          choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }]
        });
        await options?.onOpenAIChunk?.({
          id: "chatcmpl-req-sse",
          object: "chat.completion.chunk",
          created: 1,
          model: "mcoda-qwen-reviewer",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        });
        return {
          job_id: job.job_id,
          request_id: job.request_id,
          status: "success" as const,
          openai_response: {}
        };
      }
    } as unknown as SelfHostedNodeRuntime;
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/jobs",
        headers: {
          authorization: `Bearer ${signInvocationToken({
            secret: config.invocationSigningSecret || "",
            nodeId: job.node_id,
            jobId: job.job_id,
            requestId: job.request_id,
            model: job.openai_request.model
          })}`,
          "content-type": "application/json",
          "x-mswarm-attached-api-key": "msw_docdex_direct"
        },
        payload: job
      });

      expect(response.statusCode).toBe(200);
      expect(capturedAttachedMswarmApiKey).toBe("msw_docdex_direct");
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.payload).toContain("data: {");
      expect(response.payload).toContain("\"object\":\"chat.completion.chunk\"");
      expect(response.payload).toContain("\"content\":\"pong\"");
      expect(response.payload).toContain("data: [DONE]");
    } finally {
      await app.close();
    }
  });

  it("normalizes node subcommands while preserving top-level compatibility aliases", () => {
    expect(normalizeMswarmCommand(["node", "mswarm", "node", "install", "--api-key", "msw_owner"])).toEqual({
      namespace: "node",
      command: "install",
      args: ["--api-key", "msw_owner"]
    });
    expect(normalizeMswarmCommand(["node", "mswarm", "node", "restart"])).toEqual({
      namespace: "node",
      command: "restart",
      args: []
    });
    expect(normalizeMswarmCommand(["node", "mswarm", "install", "msw_owner"])).toEqual({
      namespace: null,
      command: "install",
      args: ["msw_owner"]
    });
  });

  it("installs a launchd daemon service without persisting owner or runtime secrets", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const commands: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
    const runner: CommandRunner = async (command, args, options) => {
      commands.push({ command, args, timeoutMs: options.timeoutMs });
      return { stdout: "", stderr: "" };
    };

    const result = await installSelfHostedNodeService(serviceConfigFor(statePath), {
      commandPath: "/opt/mcoda/mswarm/dist/server.js",
      nodePath: "/usr/local/bin/node",
      platform: "darwin",
      homeDir,
      env: {
        HOME: homeDir,
        PATH: "/usr/local/bin:/usr/bin",
        MSWARM_API_KEY: "msw_owner"
      } as NodeJS.ProcessEnv,
      runner
    });

    const plist = await readFile(result.servicePath, "utf8");
    const wrapper = await readFile(result.wrapperPath, "utf8");
    expect(result.manager).toBe("launchd");
    expect(result.servicePath).toBe(join(homeDir, "Library", "LaunchAgents", "com.mcoda.mswarm.self-hosted-node.plist"));
    expect(result.wrapperPath).toBe(join(homeDir, ".mswarm", "self-hosted-node", "mswarm-node"));
    expect(plist).toContain("<string>com.mcoda.mswarm.self-hosted-node</string>");
    expect(plist).toContain(`<string>${result.wrapperPath}</string>`);
    expect(plist).not.toContain("<string>/usr/bin/env</string>");
    expect(plist).not.toContain("<string>/usr/local/bin/node</string>");
    expect(plist).not.toContain("<string>/opt/mcoda/mswarm/dist/server.js</string>");
    expect(plist).not.toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).not.toContain("msw_owner");
    expect(plist).not.toContain("runtime-token-should-not-be-written");
    expect(plist).not.toContain("signing-secret-should-not-be-written");
    expect(wrapper).toContain("exec /usr/bin/env -i");
    expect(wrapper).toContain(`'USER=${userInfo().username}'`);
    expect(wrapper).toContain(`'LOGNAME=${userInfo().username}'`);
    expect(wrapper).toContain(`'USERNAME=${userInfo().username}'`);
    expect(wrapper).toContain("'MSWARM_SELF_HOSTED_PROCESS_TITLE=mswarm-node'");
    expect(wrapper).toContain("'MSWARM_SELF_HOSTED_EXPOSURE_POLICY=all'");
    expect(wrapper).toContain("'MSWARM_SELF_HOSTED_NODE_KEY_PATH=");
    expect(wrapper).toContain("'MSWARM_GATEWAY_BASE_URL=https://gateway.test'");
    expect(wrapper).toContain("'/usr/local/bin/node'");
    expect(wrapper).toContain("'/opt/mcoda/mswarm/dist/server.js'");
    expect(wrapper).toContain("'start'");
    expect(wrapper).not.toContain("msw_owner");
    expect(wrapper).not.toContain("runtime-token-should-not-be-written");
    expect(wrapper).not.toContain("signing-secret-should-not-be-written");
    expect(commands.some((entry) => entry.command === "launchctl" && entry.args[0] === "bootstrap")).toBe(true);
    expect(commands.some((entry) => entry.command === "launchctl" && entry.args[0] === "kickstart")).toBe(true);
    expect(commands.every((entry) => entry.timeoutMs >= 60_000)).toBe(true);
  });

  it("treats launchd install bootstrap error 5 as success when the service is already loaded", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const domain = testLaunchdDomain();
    const serviceTarget = `${domain}/com.mcoda.mswarm.self-hosted-node`;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      commands.push({ command, args });
      if (args[0] === "bootstrap") {
        throw new Error("Bootstrap failed: 5: Input/output error");
      }
      return { stdout: args[0] === "print" ? "service = com.mcoda.mswarm.self-hosted-node" : "", stderr: "" };
    };

    const result = await installSelfHostedNodeService(serviceConfigFor(statePath), {
      commandPath: "/opt/mcoda/mswarm/dist/server.js",
      nodePath: "/usr/local/bin/node",
      platform: "darwin",
      homeDir,
      env: { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin" } as NodeJS.ProcessEnv,
      runner
    });

    expect(result.started).toBe(true);
    expect(commands).toEqual([
      { command: "launchctl", args: ["bootout", serviceTarget] },
      {
        command: "launchctl",
        args: ["bootout", domain, join(homeDir, "Library", "LaunchAgents", "com.mcoda.mswarm.self-hosted-node.plist")]
      },
      {
        command: "launchctl",
        args: ["bootstrap", domain, join(homeDir, "Library", "LaunchAgents", "com.mcoda.mswarm.self-hosted-node.plist")]
      },
      { command: "launchctl", args: ["print", serviceTarget] },
      { command: "launchctl", args: ["enable", serviceTarget] },
      { command: "launchctl", args: ["kickstart", "-k", serviceTarget] }
    ]);
  });

  it("installs a systemd user service with restart policy and without owner or runtime secrets", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      commands.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    const result = await installSelfHostedNodeService(serviceConfigFor(statePath), {
      commandPath: "/opt/mcoda/mswarm/dist/server.js",
      nodePath: "/usr/bin/node",
      platform: "linux",
      homeDir,
      env: {
        HOME: homeDir,
        USER: "ada",
        PATH: "/usr/bin:/bin",
        MSWARM_API_KEY: "msw_owner"
      } as NodeJS.ProcessEnv,
      runner
    });

    const service = await readFile(result.servicePath, "utf8");
    const wrapper = await readFile(result.wrapperPath, "utf8");
    expect(result.manager).toBe("systemd");
    expect(result.servicePath).toBe(join(homeDir, ".config", "systemd", "user", "mswarm-self-hosted-node.service"));
    expect(result.wrapperPath).toBe(join(homeDir, ".mswarm", "self-hosted-node", "mswarm-node"));
    expect(service).toContain(`ExecStart=${quoteSystemdValueForTest(result.wrapperPath)}`);
    expect(service).not.toContain("ExecStart=/usr/bin/env -i");
    expect(service).not.toContain("/opt/mcoda/mswarm/dist/server.js");
    expect(service).toContain("Restart=always");
    expect(service).not.toContain("Environment=");
    expect(service).not.toContain("msw_owner");
    expect(service).not.toContain("runtime-token-should-not-be-written");
    expect(service).not.toContain("signing-secret-should-not-be-written");
    expect(wrapper).toContain("exec /usr/bin/env -i");
    expect(wrapper).toContain("'USER=ada'");
    expect(wrapper).toContain("'LOGNAME=ada'");
    expect(wrapper).toContain("'USERNAME=ada'");
    expect(wrapper).toContain("'MSWARM_SELF_HOSTED_PROCESS_TITLE=mswarm-node'");
    expect(wrapper).toContain("'MSWARM_SELF_HOSTED_EXPOSURE_POLICY=all'");
    expect(wrapper).toContain("'MSWARM_GATEWAY_BASE_URL=https://gateway.test'");
    expect(wrapper).toContain("'/usr/bin/node'");
    expect(wrapper).toContain("'/opt/mcoda/mswarm/dist/server.js'");
    expect(wrapper).toContain("'start'");
    expect(wrapper).not.toContain("msw_owner");
    expect(wrapper).not.toContain("runtime-token-should-not-be-written");
    expect(wrapper).not.toContain("signing-secret-should-not-be-written");
    expect(commands).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "mswarm-self-hosted-node.service"] },
      { command: "loginctl", args: ["enable-linger", "ada"] },
      { command: "systemctl", args: ["--user", "restart", "mswarm-self-hosted-node.service"] }
    ]);
  });

  it("installs a Windows scheduled task wrapper with restart loop and without owner or runtime secrets", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      commands.push({ command, args });
      return { stdout: "", stderr: "" };
    };
    const commandPath = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@mcoda\\mswarm\\dist\\server.js";
    const nodePath = "C:\\Program Files\\nodejs\\node.exe";

    const result = await installSelfHostedNodeService(serviceConfigFor(statePath), {
      commandPath,
      nodePath,
      platform: "win32",
      homeDir,
      env: {
        Path: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
        MSWARM_API_KEY: "msw_owner"
      } as NodeJS.ProcessEnv,
      runner
    });

    const script = await readFile(result.servicePath, "utf8");
    expect(result.manager).toBe("windows-task-scheduler");
    expect(result.serviceName).toBe("MswarmSelfHostedNode");
    expect(result.servicePath).toBe(join(homeDir, ".mswarm", "self-hosted-node", "mswarm-self-hosted-node.ps1"));
    expect(script).toContain(`$nodePath = '${nodePath}'`);
    expect(script).toContain(`$commandArguments = @('${commandPath}', 'start')`);
    expect(script).toContain("$allowedInheritedEnvironment = @(");
    expect(script).toContain("Remove-Item -Path (\"Env:\" + $_.Name) -ErrorAction SilentlyContinue");
    expect(script).toContain("& $nodePath @commandArguments");
    expect(script).toContain("while ($true)");
    expect(script).toContain("Start-Sleep -Seconds 5");
    expect(script).toContain("$env:MSWARM_SELF_HOSTED_PROCESS_TITLE = 'mswarm-node'");
    expect(script).toContain("$env:MSWARM_SELF_HOSTED_EXPOSURE_POLICY = 'all'");
    expect(script).toContain("$env:MSWARM_SELF_HOSTED_NODE_KEY_PATH");
    expect(script).toContain("$env:MSWARM_GATEWAY_BASE_URL");
    expect(script).not.toContain("msw_owner");
    expect(script).not.toContain("runtime-token-should-not-be-written");
    expect(script).not.toContain("signing-secret-should-not-be-written");
    expect(commands).toHaveLength(2);
    expect(commands[0]?.command).toBe("powershell.exe");
    expect(commands[0]?.args.slice(0, 4)).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]);
    expect(commands[0]?.args[4]).toContain("Stop-ScheduledTask -TaskName 'MswarmSelfHostedNode'");
    expect(commands[0]?.args[4]).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(commands[0]?.args[4]).toContain("-ExecutionTimeLimit (New-TimeSpan -Seconds 0)");
    expect(commands[0]?.args[4]).toContain("-RestartCount 999");
    expect(commands[0]?.args[4]).toContain(`-File "${result.servicePath}"`);
    expect(commands[0]?.args[4]).not.toContain("msw_owner");
    expect(commands).toEqual([
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          commands[0]?.args[4] || ""
        ]
      },
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Start-ScheduledTask -TaskName 'MswarmSelfHostedNode'"]
      }
    ]);
  });

  it("redacts sensitive service-manager status output", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const runner: CommandRunner = async () => ({
      stdout: [
        "\tOPENAI_API_KEY => sk-do-not-print",
        "\tMSWARM_SELF_HOSTED_NODE_KEY_PATH => /Users/ada/.mswarm/self-hosted-node/node.key",
        "\tMSWARM_SELF_HOSTED_RUNTIME_TOKEN => runtime-do-not-print"
      ].join("\n"),
      stderr: "\tSERVICE_SECRET: service-do-not-print"
    });

    const status = await controlSelfHostedNodeService("status", { platform: "darwin", homeDir, runner });

    expect(status.stdout).toContain("OPENAI_API_KEY => [redacted]");
    expect(status.stdout).toContain("MSWARM_SELF_HOSTED_NODE_KEY_PATH => /Users/ada/.mswarm/self-hosted-node/node.key");
    expect(status.stdout).toContain("MSWARM_SELF_HOSTED_RUNTIME_TOKEN => [redacted]");
    expect(status.stderr).toContain("SERVICE_SECRET: [redacted]");
    expect(status.stdout).not.toContain("sk-do-not-print");
    expect(status.stdout).not.toContain("runtime-do-not-print");
    expect(status.stderr).not.toContain("service-do-not-print");
  });

  it("starts an already loaded launchd daemon after proving it is bootstrapped", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const domain = testLaunchdDomain();
    const serviceTarget = `${domain}/com.mcoda.mswarm.self-hosted-node`;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      commands.push({ command, args });
      if (args[0] === "bootstrap") {
        throw new Error("Bootstrap failed: 5: Input/output error");
      }
      return { stdout: args[0] === "print" ? "service = com.mcoda.mswarm.self-hosted-node" : "", stderr: "" };
    };

    const start = await controlSelfHostedNodeService("start", { platform: "darwin", homeDir, runner });

    expect(start.ok).toBe(true);
    expect(commands).toEqual([
      {
        command: "launchctl",
        args: ["bootstrap", domain, join(homeDir, "Library", "LaunchAgents", "com.mcoda.mswarm.self-hosted-node.plist")]
      },
      { command: "launchctl", args: ["print", serviceTarget] },
      { command: "launchctl", args: ["enable", serviceTarget] },
      { command: "launchctl", args: ["kickstart", "-k", serviceTarget] }
    ]);
  });

  it("does not hide launchd bootstrap failures during restart", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const domain = testLaunchdDomain();
    const serviceTarget = `${domain}/com.mcoda.mswarm.self-hosted-node`;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      commands.push({ command, args });
      if (args[0] === "bootstrap") {
        throw new Error("Bootstrap failed: 5: Input/output error");
      }
      if (args[0] === "print") {
        throw new Error("Could not find service");
      }
      return { stdout: "", stderr: "" };
    };

    await assert.rejects(
      () => controlSelfHostedNodeService("restart", { platform: "darwin", homeDir, runner }),
      /Bootstrap failed/
    );

    expect(commands).toEqual([
      { command: "launchctl", args: ["bootout", serviceTarget] },
      {
        command: "launchctl",
        args: ["bootstrap", domain, join(homeDir, "Library", "LaunchAgents", "com.mcoda.mswarm.self-hosted-node.plist")]
      },
      { command: "launchctl", args: ["print", serviceTarget] },
      {
        command: "launchctl",
        args: ["bootstrap", domain, join(homeDir, "Library", "LaunchAgents", "com.mcoda.mswarm.self-hosted-node.plist")]
      },
      { command: "launchctl", args: ["print", serviceTarget] }
    ]);
  });

  it("controls Linux user daemon lifecycle through systemd", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      commands.push({ command, args });
      return { stdout: command === "systemctl" && args.includes("status") ? "active\n" : "", stderr: "" };
    };

    const layout = resolveSelfHostedNodeServiceLayout({ platform: "linux", homeDir });
    const restart = await controlSelfHostedNodeService("restart", { platform: "linux", homeDir, runner });
    const status = await controlSelfHostedNodeService("status", { platform: "linux", homeDir, runner });

    expect(layout.manager).toBe("systemd");
    expect(restart.ok).toBe(true);
    expect(restart.servicePath).toBe(join(homeDir, ".config", "systemd", "user", "mswarm-self-hosted-node.service"));
    expect(status.stdout).toBe("active\n");
    expect(commands).toEqual([
      { command: "systemctl", args: ["--user", "restart", "mswarm-self-hosted-node.service"] },
      { command: "systemctl", args: ["--user", "status", "--no-pager", "mswarm-self-hosted-node.service"] }
    ]);
  });

  it("controls and uninstalls Windows scheduled task daemon lifecycle", async () => {
    const statePath = tempStatePath();
    const homeDir = dirname(statePath);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      commands.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    const restart = await controlSelfHostedNodeService("restart", { platform: "win32", homeDir, runner });
    const uninstall = await uninstallSelfHostedNodeService({ platform: "win32", homeDir, runner });

    expect(restart.manager).toBe("windows-task-scheduler");
    expect(restart.ok).toBe(true);
    expect(uninstall.action).toBe("uninstall");
    expect(commands[0]).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Stop-ScheduledTask -TaskName 'MswarmSelfHostedNode' -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName 'MswarmSelfHostedNode'"
      ]
    });
    expect(commands[1]?.command).toBe("powershell.exe");
    expect(commands[1]?.args[4]).toContain("Unregister-ScheduledTask -TaskName 'MswarmSelfHostedNode'");
  });

  it("bootstraps setup with an owner API key, stores only the runtime token, and runs immediate sync", async () => {
    const statePath = tempStatePath();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, init: init || {} });
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/bootstrap") {
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("msw_owner");
        const body = JSON.parse(String(init?.body));
        expect(body.machine_fingerprint).toMatch(/^sha256:/);
        expect(body.server_name).toBe("setup-box");
        expect(body.relay_mode).toBe("outbound");
        return jsonResponse({
          created: true,
          enrolled: true,
          node: { node_id: "shn_setup", server_name: "setup-box", relay_mode: "outbound" },
          runtime_token: "msn_setup",
          config_version: 1,
          heartbeat_interval_seconds: 30,
          heartbeat_timeout_seconds: 90,
          relay: { mode: "outbound", gateway_base_url: "https://gateway.test" }
        });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/heartbeat") {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer msn_setup");
        const body = JSON.parse(String(init?.body));
        expect(body.node_id).toBe("shn_setup");
        expect(body.models).toHaveLength(1);
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const mcoda = new McodaAgentInventoryClient({
      runner: async () => ({
        stdout: JSON.stringify([
          {
            slug: "phi3-reviewer",
            adapter: "ollama-remote",
            defaultModel: "phi3.5:latest",
            bestUsage: "code_review",
            health: { status: "healthy" }
          }
        ]),
        stderr: ""
      })
    });

    const setupConfig = await readOwnerSetupConfig(
      [
        "--api-key",
        "msw_owner",
        "--gateway",
        "https://gateway.test",
        "--server-name",
        "setup-box",
        "--allow",
        "phi3-reviewer",
        "--expose-all"
      ],
      {
        MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
        MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath),
        MSWARM_SELF_HOSTED_MACHINE_ID_PATH: join(dirname(statePath), "machine.id")
      } as NodeJS.ProcessEnv
    );
    expect(setupConfig.nodeVersion).toBe(await packageVersion());
    const result = await SelfHostedNodeRuntime.setup(setupConfig, { fetchImpl, mcoda });
    expect(result.nodeId).toBe("shn_setup");
    expect(result.modelCount).toBe(1);
    const savedState = JSON.parse(await readFile(statePath, "utf8"));
    expect(savedState.node_id).toBe("shn_setup");
    expect(savedState.runtime_token).toBeUndefined();
    expect(savedState.machine_fingerprint).toMatch(/^sha256:/);
    expect(savedState.exposure_policy).toBe("all");
    expect(savedState.job_timeout_ms).toBe(3_600_000);
    expect((await readFile(tempRuntimeTokenPath(statePath), "utf8")).trim()).toBe("msn_setup");
    const daemonConfig = await readSelfHostedNodeConfig({
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath)
    } as NodeJS.ProcessEnv);
    expect(daemonConfig.exposeAllModels).toBe(true);
    expect(daemonConfig.jobTimeoutMs).toBe(3_600_000);
    expect(daemonConfig.modelAllowlist).toEqual(["phi3-reviewer"]);
    expect(daemonConfig.discoveryMode).toBe("mcoda");
    expect(daemonConfig.nodeVersion).toBe(await packageVersion());
    expect(calls.filter((call) => call.url.endsWith("/node/bootstrap"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/node/heartbeat"))).toHaveLength(1);
  });

  it("reports the installed package version instead of stale persisted node metadata", async () => {
    const statePath = tempStatePath();
    const runtimeTokenPath = tempRuntimeTokenPath(statePath);
    writeFileSync(
      statePath,
      JSON.stringify({
        node_id: "shn_stale",
        node_version: "0.1.1",
        gateway_base_url: "https://gateway.test",
        discovery_mode: "mcoda"
      }),
      "utf8"
    );
    writeFileSync(runtimeTokenPath, "runtime-token\n", "utf8");

    const config = await readSelfHostedNodeConfig({
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_NODE_KEY_PATH: runtimeTokenPath,
      MSWARM_SELF_HOSTED_NODE_VERSION: "0.1.1"
    } as NodeJS.ProcessEnv);

    expect(config.nodeVersion).toBe(await packageVersion());
  });

  it("notifies the gateway when uninstalling a configured node", async () => {
    const statePath = tempStatePath();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, init: init || {} });
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/uninstall") {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          "Bearer runtime-token-should-not-be-written"
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          node_id: "shn_service",
          reason: "node_uninstall",
          source: "mswarm_node_uninstall",
          node_version: "test-node",
          service_manager: "launchd"
        });
        return jsonResponse({ accepted: true, node: { node_id: "shn_service", status: "unreachable" } });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;

    const runtime = new SelfHostedNodeRuntime(serviceConfigFor(statePath), { fetchImpl });
    const result = await runtime.notifyUninstall({ serviceManager: "launchd" });

    expect(result.notified).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not block local uninstall when gateway notification fails", async () => {
    const statePath = tempStatePath();
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const runtime = new SelfHostedNodeRuntime(serviceConfigFor(statePath), { fetchImpl });
    const result = await runtime.notifyUninstall({ serviceManager: "systemd" });

    expect(result.notified).toBe(false);
    expect(result.error).toContain("network down");
  });

  it("enrolls once, stores runtime token, and sends heartbeat with Ollama inventory", async () => {
    const statePath = tempStatePath();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, init: init || {} });
      if (target === "http://ollama.test/api/version") {
        return jsonResponse({ version: "0.1.48" });
      }
      if (target === "http://ollama.test/api/tags") {
        return jsonResponse({
          models: [
            {
              name: "phi3.5:3.8b",
              digest: "61819fb370a3",
              details: {
                family: "phi3",
                parameter_size: "3.8B",
                quantization_level: "Q4_0"
              }
            }
          ]
        });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/enroll") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          node_id: "shn_test",
          enrollment_token: "mse_test"
        });
        return jsonResponse({
          runtime_token: "msn_runtime",
          config_version: 1,
          heartbeat_interval_seconds: 30,
          heartbeat_timeout_seconds: 90
        });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/heartbeat") {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer msn_runtime");
        const body = JSON.parse(String(init?.body));
        expect(body.node_id).toBe("shn_test");
        expect(body.status).toBe("online");
        expect(body.ollama.version).toBe("0.1.48");
        expect(body.models).toHaveLength(1);
        expect(body.models[0].name).toBe("phi3.5:3.8b");
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;

    const runtime = new SelfHostedNodeRuntime(
      {
        gatewayBaseUrl: "https://gateway.test",
        nodeId: "shn_test",
        enrollmentToken: "mse_test",
        runtimeToken: null,
        discoveryMode: "ollama",
        mcodaBin: "mcoda",
        mcodaListArgs: ["agent", "list", "--json", "--refresh-health"],
        ollamaBaseUrl: "http://ollama.test",
        statePath,
        runtimeTokenPath: tempRuntimeTokenPath(statePath),
        invocationSigningSecret: null,
        listenHost: "127.0.0.1",
        listenPort: 18083,
        nodeVersion: "test-node",
        heartbeatIntervalSeconds: 30,
        requestTimeoutMs: 1000,
        jobTimeoutMs: 3_600_000,
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: []
      },
      { fetchImpl }
    );

    const result = await runtime.runOnce();
    expect(result.enrolled).toBe(true);
    expect(result.status).toBe("online");
    expect(result.model_count).toBe(1);
    const savedState = JSON.parse(await readFile(statePath, "utf8"));
    const savedRuntimeToken = await readFile(tempRuntimeTokenPath(statePath), "utf8");
    expect(savedState.runtime_token).toBeUndefined();
    expect(savedRuntimeToken.trim()).toBe("msn_runtime");

    const secondRuntime = new SelfHostedNodeRuntime(
      {
        gatewayBaseUrl: "https://gateway.test",
        nodeId: "shn_test",
        enrollmentToken: null,
        runtimeToken: null,
        discoveryMode: "ollama",
        mcodaBin: "mcoda",
        mcodaListArgs: ["agent", "list", "--json", "--refresh-health"],
        ollamaBaseUrl: "http://ollama.test",
        statePath,
        runtimeTokenPath: tempRuntimeTokenPath(statePath),
        invocationSigningSecret: null,
        listenHost: "127.0.0.1",
        listenPort: 18083,
        nodeVersion: "test-node",
        heartbeatIntervalSeconds: 30,
        requestTimeoutMs: 1000,
        jobTimeoutMs: 3_600_000,
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: []
      },
      { fetchImpl }
    );
    await secondRuntime.runOnce();
    expect(calls.filter((call) => call.url.endsWith("/node/enroll"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/node/heartbeat"))).toHaveLength(2);
  });

  it("sends heartbeat with mcoda local agent inventory by default", async () => {
    const statePath = tempStatePath();
    const heartbeatBodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/heartbeat") {
        heartbeatBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const mcoda = new McodaAgentInventoryClient({
      runner: async () => ({
        stdout: JSON.stringify([
          {
            id: "agent-phi",
            slug: "phi3-reviewer",
            adapter: "ollama-remote",
            defaultModel: "phi3.5:latest",
            contextWindow: 4000,
            maxOutputTokens: 2048,
            supportsTools: false,
            bestUsage: "code_review",
            costPerMillion: 0,
            rating: 4.01,
            reasoningRating: 4.01,
            maxComplexity: 5,
            capabilities: ["code_review", "plan"],
            health: { status: "healthy" }
          },
          {
            id: "agent-embed",
            slug: "nomic-embed-text",
            adapter: "ollama-remote",
            defaultModel: "nomic-embed-text:latest",
            bestUsage: "embedding",
            health: { status: "healthy" }
          }
        ]),
        stderr: ""
      })
    });

    const runtime = new SelfHostedNodeRuntime(
      {
        gatewayBaseUrl: "https://gateway.test",
        nodeId: "shn_mcoda",
        enrollmentToken: null,
        runtimeToken: "msn_existing",
        discoveryMode: "mcoda",
        mcodaBin: "mcoda",
        mcodaListArgs: ["agent", "list", "--json", "--refresh-health"],
        ollamaBaseUrl: "http://ollama.test",
        statePath,
        runtimeTokenPath: tempRuntimeTokenPath(statePath),
        invocationSigningSecret: null,
        listenHost: "127.0.0.1",
        listenPort: 18083,
        nodeVersion: "test-node",
        heartbeatIntervalSeconds: 30,
        requestTimeoutMs: 1000,
        jobTimeoutMs: 3_600_000,
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: []
      },
      { fetchImpl, mcoda }
    );

    const result = await runtime.runOnce();
    expect(result.status).toBe("online");
    expect(result.discovery_source).toBe("mcoda");
    expect(result.model_count).toBe(1);
    expect(result.mcoda_agent_count).toBe(1);
    expect(heartbeatBodies[0].discovery).toMatchObject({ source: "mcoda", mcoda_status: "ok" });
    const models = heartbeatBodies[0].models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      name: "phi3-reviewer",
      provider: "mcoda",
      adapter: "ollama-remote",
      source_agent_slug: "phi3-reviewer",
      model_id: "phi3.5:latest"
    });
    expect(models[0].exposed).toBe(true);
    expect(models[1]).toMatchObject({
      name: "nomic-embed-text",
      exposed: false,
      best_usage: "embedding"
    });
  });

  it("sends a degraded heartbeat when Ollama is unavailable", async () => {
    const statePath = tempStatePath();
    const heartbeatBodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "http://ollama.test/api/version" || target === "http://ollama.test/api/tags") {
        return jsonResponse({ error: "offline" }, 503);
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/heartbeat") {
        heartbeatBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;

    const runtime = new SelfHostedNodeRuntime(
      {
        gatewayBaseUrl: "https://gateway.test",
        nodeId: "shn_degraded",
        enrollmentToken: null,
        runtimeToken: "msn_existing",
        discoveryMode: "ollama",
        mcodaBin: "mcoda",
        mcodaListArgs: ["agent", "list", "--json", "--refresh-health"],
        ollamaBaseUrl: "http://ollama.test",
        statePath,
        runtimeTokenPath: tempRuntimeTokenPath(statePath),
        invocationSigningSecret: null,
        listenHost: "127.0.0.1",
        listenPort: 18083,
        nodeVersion: "test-node",
        heartbeatIntervalSeconds: 30,
        requestTimeoutMs: 1000,
        jobTimeoutMs: 3_600_000,
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: []
      },
      { fetchImpl }
    );

    const result = await runtime.runOnce();
    expect(result.status).toBe("degraded");
    expect(result.model_count).toBe(0);
    expect(heartbeatBodies[0].status).toBe("degraded");
    expect((heartbeatBodies[0].models as unknown[])).toHaveLength(0);
  });
});
