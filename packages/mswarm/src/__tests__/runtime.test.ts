import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildInstallSetupArgs,
  buildNodeInstallSetupArgs,
  buildSelfHostedNodeApp,
  isSelfHostedNodeDirectRun,
  normalizeMswarmCommand
} from "../server.js";
import {
  MSWARM_CODALI_FEEDBACK_SUBMISSION_SCHEMA_VERSION,
  MSWARM_CODALI_PRODUCT_METADATA_SCHEMA_VERSION,
  MswarmCodaliExecutor,
  type MswarmCodaliInvocationInput,
  type MswarmCodaliInvocationResult
} from "../codali-executor.js";
import {
  type CommandRunner,
  type MswarmGenericJobRunner,
  type MswarmGenericJobRunnerContext,
  type SelfHostedGenericNodeJob,
  type SelfHostedNodeInvocationJob,
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

function tempArtifactStorePath(statePath: string): string {
  return join(dirname(statePath), "artifacts");
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
    maxConcurrentJobs: 1,
    maxConcurrentLlmJobs: 1,
    genericJobsEnabled: false,
    genericJobTimeoutMs: 3_600_000,
    genericJobMaxConcurrency: 1,
    drainMode: false,
    loadReportingEnabled: true,
    hardwareTelemetryEnabled: false,
    exposeAllModels: true,
    modelAllowlist: ["phi3-reviewer"],
    modelBlocklist: ["nomic-embed-text:latest"],
    clientAllowlist: []
  };
}

function permissiveServiceConfigFor(statePath: string): SelfHostedNodeConfig {
  return {
    ...serviceConfigFor(statePath),
    modelAllowlist: []
  };
}

function genericServiceConfigFor(statePath: string, overrides: Partial<SelfHostedNodeConfig> = {}): SelfHostedNodeConfig {
  return {
    ...serviceConfigFor(statePath),
    genericJobsEnabled: true,
    genericJobTimeoutMs: 1_000,
    relayMode: "direct",
    ...overrides
  };
}

function genericEchoJob(overrides: Partial<SelfHostedGenericNodeJob> = {}): SelfHostedGenericNodeJob {
  return {
    job_id: "job-generic-echo",
    request_id: "req-generic-echo",
    node_id: "shn_service",
    job: {
      schema_version: "2026-06-14",
      job_type: "tenant.test-echo",
      args: {
        message: "hello generic"
      },
      policy: {
        trust_mode: "owner-local",
        network: "none",
        allow_raw_command: false
      },
      limits: {
        timeout_sec: 1
      }
    },
    ...overrides
  };
}

function genericBlenderJob(overrides: Partial<SelfHostedGenericNodeJob> = {}): SelfHostedGenericNodeJob {
  return {
    job_id: "job-render-blender",
    request_id: "req-render-blender",
    node_id: "shn_service",
    job: {
      schema_version: "2026-06-14",
      job_type: "render.blender",
      inputs: [
        {
          name: "scene",
          artifact: {
            uri: "artifact://local/upstream-render/scene.blend",
            content_type: "application/octet-stream"
          },
          mount_path: "scene.blend",
          required: true
        }
      ],
      args: {
        frames: "1-2",
        engine: "cycles",
        resolution: "640x360",
        output_format: "png"
      },
      outputs: [
        {
          name: "frames",
          path: "frames",
          content_type: "image/png",
          required: true
        }
      ],
      policy: {
        trust_mode: "owner-local",
        network: "none",
        allow_raw_command: false
      },
      limits: {
        timeout_sec: 1
      }
    },
    ...overrides
  };
}

function genericCudaJob(overrides: Partial<SelfHostedGenericNodeJob> = {}): SelfHostedGenericNodeJob {
  return {
    job_id: "job-cuda-run",
    request_id: "req-cuda-run",
    node_id: "shn_service",
    job: {
      schema_version: "2026-06-14",
      job_type: "cuda.run",
      inputs: [
        {
          name: "package",
          artifact: {
            uri: "artifact://local/upstream-cuda/package.tar.gz",
            content_type: "application/gzip"
          },
          mount_path: "package.tar.gz",
          required: true
        },
        {
          name: "manifest",
          artifact: {
            uri: "artifact://local/upstream-cuda/mcoda-job.json",
            content_type: "application/json"
          },
          mount_path: "mcoda-job.json",
          required: true
        }
      ],
      args: {
        manifest_path: "mcoda-job.json",
        profile: "nvcc-default",
        target: "vector-add"
      },
      resources: {
        gpu: {
          count: 1,
          vendor: "nvidia",
          cuda_min_version: "12.0"
        },
        memory_gb: 4,
        disk_gb: 8
      },
      limits: {
        timeout_sec: 2,
        max_stdout_bytes: 1024 * 1024,
        max_stderr_bytes: 1024 * 1024,
        max_output_bytes: 1024 * 1024
      },
      outputs: [
        {
          name: "result",
          path: "results/result.txt",
          content_type: "text/plain",
          required: true
        }
      ],
      policy: {
        trust_mode: "owner-local",
        network: "none",
        allow_raw_command: false,
        allowed_images: ["nvidia/cuda:12.4.1-devel-ubuntu22.04"],
        allowed_package_publishers: ["mcoda.local"],
        max_artifact_bytes: 1024 * 1024
      }
    },
    ...overrides
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

function capabilityProbeRunner(
  results: Record<string, { stdout?: string; stderr?: string; error?: string | Error }>
): CommandRunner {
  return async (command) => {
    const result = results[command];
    if (!result) {
      throw new Error(`${command} not found`);
    }
    if (result.error) {
      throw result.error instanceof Error ? result.error : new Error(result.error);
    }
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  };
}

function gpuCapabilityProbeRunner(): CommandRunner {
  return async (command, args) => {
    if (command === "nvidia-smi" && args.length === 0) {
      return { stdout: "NVIDIA-SMI 550.54.14    CUDA Version: 12.4    Serial GPU-SERIAL-0001\n", stderr: "" };
    }
    if (command === "nvidia-smi") {
      return { stdout: "0, NVIDIA RTX 4090, 24564, 550.54.14, 8.9\n", stderr: "" };
    }
    if (command === "docker") {
      return {
        stdout: JSON.stringify({
          runc: { path: "runc" },
          nvidia: { path: "nvidia-container-runtime" }
        }),
        stderr: ""
      };
    }
    if (command === "blender") {
      return { stdout: "Blender 4.1.1\n", stderr: "" };
    }
    if (command === "ffmpeg") {
      return { stdout: "ffmpeg version 6.1 Copyright\n", stderr: "" };
    }
    throw new Error(`${command} not found`);
  };
}

function blenderCapabilityAndRenderRunner(captured: { args?: string[]; command?: string }): CommandRunner {
  return async (command, args) => {
    if (command === "nvidia-smi" && args.length === 0) {
      return { stdout: "NVIDIA-SMI 550.54.14    CUDA Version: 12.4\n", stderr: "" };
    }
    if (command === "nvidia-smi") {
      return { stdout: "0, NVIDIA RTX 4090, 24564, 550.54.14, 8.9\n", stderr: "" };
    }
    if (command === "docker") {
      return {
        stdout: JSON.stringify({
          runc: { path: "runc" },
          nvidia: { path: "nvidia-container-runtime" }
        }),
        stderr: ""
      };
    }
    if (command === "ffmpeg") {
      return { stdout: "ffmpeg version 6.1 Copyright\n", stderr: "" };
    }
    if (command === "blender" && args.includes("--version")) {
      return { stdout: "Blender 4.1.1\n", stderr: "" };
    }
    if (command === "blender") {
      captured.command = command;
      captured.args = [...args];
      const outputIndex = args.indexOf("--render-output");
      const outputPattern = outputIndex >= 0 ? args[outputIndex + 1] : "";
      if (!outputPattern) {
        throw new Error("missing render output path");
      }
      const renderedPath = `${outputPattern.replace("####", "0001")}.png`;
      mkdirSync(dirname(renderedPath), { recursive: true });
      writeFileSync(renderedPath, "fake png frame\n", "utf8");
      return {
        stdout: "Fra:1 Mem:12.00M\nFra:2 Mem:12.00M\n",
        stderr: "Saved: frame_0001.png\n"
      };
    }
    throw new Error(`${command} not found`);
  };
}

function validCudaManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "2026-06-14",
    package: {
      name: "vector-add",
      publisher: "mcoda.local"
    },
    profiles: {
      "nvcc-default": {
        image: "nvidia/cuda:12.4.1-devel-ubuntu22.04",
        compiler: "nvcc",
        flags: ["-O2", "--std=c++17"]
      }
    },
    targets: {
      "vector-add": {
        source: "src/vector_add.cu",
        output: "bin/vector-add",
        args: ["--size=32"]
      }
    },
    ...overrides
  };
}

function writeCudaUpstreamArtifacts(artifactStorePath: string, manifest: Record<string, unknown> = validCudaManifest()): void {
  mkdirSync(join(artifactStorePath, "upstream-cuda", "outputs"), { recursive: true });
  writeFileSync(join(artifactStorePath, "upstream-cuda", "outputs", "package.tar.gz"), "fake tgz\n", "utf8");
  writeFileSync(
    join(artifactStorePath, "upstream-cuda", "outputs", "mcoda-job.json"),
    JSON.stringify(manifest),
    "utf8"
  );
}

function cudaCapabilityAndDockerRunner(captured: { args?: string[]; command?: string }): CommandRunner {
  return async (command, args) => {
    if (command === "nvidia-smi" && args.length === 0) {
      return { stdout: "NVIDIA-SMI 550.54.14    CUDA Version: 12.4\n", stderr: "" };
    }
    if (command === "nvidia-smi") {
      return { stdout: "0, NVIDIA RTX 4090, 24564, 550.54.14, 8.9\n", stderr: "" };
    }
    if (command === "docker" && args[0] === "info") {
      return {
        stdout: JSON.stringify({
          runc: { path: "runc" },
          nvidia: { path: "nvidia-container-runtime" }
        }),
        stderr: ""
      };
    }
    if (command === "blender" && args.includes("--version")) {
      return { stdout: "Blender 4.1.1\n", stderr: "" };
    }
    if (command === "ffmpeg") {
      return { stdout: "ffmpeg version 6.1 Copyright\n", stderr: "" };
    }
    if (command === "tar" && args[0] === "-tzf") {
      return { stdout: "src/vector_add.cu\nmcoda-job.json\n", stderr: "" };
    }
    if (command === "tar" && args[0] === "-tvzf") {
      return {
        stdout: [
          "-rw-r--r-- 0/0 128 2026-06-14 00:00 src/vector_add.cu",
          "-rw-r--r-- 0/0 256 2026-06-14 00:00 mcoda-job.json"
        ].join("\n"),
        stderr: ""
      };
    }
    if (command === "docker" && args[0] === "run") {
      captured.command = command;
      captured.args = [...args];
      const outputMount = args.find((arg) => arg.includes(":/workspace/outputs:rw")) || "";
      const outputDir = outputMount.split(":/workspace/outputs:rw")[0];
      if (!outputDir) {
        throw new Error("missing output mount");
      }
      mkdirSync(join(outputDir, "results"), { recursive: true });
      writeFileSync(join(outputDir, "results", "result.txt"), "cuda ok\n", "utf8");
      return {
        stdout: "nvcc compile complete\ncuda run complete\n",
        stderr: "cuda stderr note\n"
      };
    }
    throw new Error(`${command} not found`);
  };
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
  const mode: MswarmCodaliInvocationResult["metadata"]["mode"] =
    input.policy?.allowTools === false ? "freeform" : "tool_loop";
  const runId = `run-${input.requestId}`;
  const telemetry = {
    runId,
    runtime: "codali" as const,
    mode,
    toolCallCount: 0,
    calledTools: [],
    consideredTools: [],
    registeredDynamicTools: [],
    skippedDynamicTools: [],
    dynamicToolCalls: [],
    warnings: []
  };
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
      runId,
      telemetry
    },
    openAIChunks: [],
    metadata: {
      provider: input.agent.provider || "ollama-remote",
      adapter: input.agent.adapter,
      local_model: input.agent.model,
      agent_slug: input.agent.slug,
      runtime: "codali",
      run_id: runId,
      tool_calls_executed: 0,
      called_tools: [],
      dynamic_tools_considered: [],
      dynamic_tools_registered: [],
      dynamic_tools_skipped: [],
      tool_call_details: [],
      telemetry,
      feedback_submission: {
        schema_version: MSWARM_CODALI_FEEDBACK_SUBMISSION_SCHEMA_VERSION,
        run_id: runId,
        deletion_group_id: `delete-group-${runId}`,
        target: {
          record_type: "gateway_record",
          record_id: runId,
          role: input.codaliGateway
            ? "codali_gateway_answer"
            : input.codaliJob
              ? "codali_job_result"
              : "codali_runtime_result"
        },
        candidate_records: [
          {
            record_type: "gateway_record",
            record_id: runId,
            role: input.codaliGateway
              ? "codali_gateway_answer"
              : input.codaliJob
                ? "codali_job_result"
                : "codali_runtime_result"
          }
        ],
        requester_scope: {
          visibility: "requester",
          tenant_wide: false
        },
        source: {
          runtime: "mswarm",
          job_id: input.jobId,
          request_id: input.requestId,
          agent_slug: input.agent.slug,
          ...(input.session?.id ? { session_id: input.session.id } : {})
        },
        raw_trace_included: false
      },
      touched_files: [],
      warnings: [],
      mode
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

function signGenericJobToken(input: {
  secret: string;
  nodeId: string;
  jobId: string;
  requestId: string;
  schemaVersion?: string;
  jobType: string;
}): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      node_id: input.nodeId,
      job_id: input.jobId,
      request_id: input.requestId,
      schema_version: input.schemaVersion || "2026-06-14",
      job_type: input.jobType,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      scope: "self_hosted.generic_job.invoke",
      iat: now,
      exp: now + 60
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = base64Url(createHmac("sha256", input.secret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

function signCapabilityToken(input: {
  secret: string;
  nodeId: string;
}): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      node_id: input.nodeId,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      scope: "self_hosted.capabilities.read",
      iat: now,
      exp: now + 60,
      nonce: "test-capabilities"
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = base64Url(createHmac("sha256", input.secret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

function signGenericJobOpsToken(input: {
  secret: string;
  nodeId: string;
}): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      node_id: input.nodeId,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      scope: "self_hosted.generic_job.ops.read",
      iat: now,
      exp: now + 60,
      nonce: "test-generic-job-ops"
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

  it("excludes managed mswarm self-hosted agents from self-hosted mcoda discovery", () => {
    const mapped = mapMcodaAgentToSelfHostedModel(
      {
        slug: "mswarm-self-hosted-mcoda-example-model-qwen3-6-llama-cpp",
        adapter: "openai-api",
        defaultModel: "mcoda-example-model-qwen3-6-llama-cpp",
        config: {
          mswarmSelfHosted: {
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

  it("excludes managed mswarm worker agents from self-hosted mcoda discovery", () => {
    const mapped = mapMcodaAgentToSelfHostedModel(
      {
        slug: "mswarm-worker-1f6392bc350f4dc3948e474e1e8ebf75",
        adapter: "openai-api",
        defaultModel: "mswarm-worker:worker_1f6392bc350f4dc3948e474e1e8ebf75",
        config: {
          mswarmWorker: {
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

  it("excludes legacy managed mswarm aliases by slug prefix", () => {
    const mapped = mapMcodaAgentToSelfHostedModel(
      {
        slug: "mswarm-self-hosted-mcoda-cassandra-local-mswarm-self-hosted-mcoda-example-model-qwen3-6-llama-cpp",
        adapter: "openai-api",
        defaultModel: "mcoda-example-model-qwen3-6-llama-cpp",
        config: {}
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
      MSWARM_SELF_HOSTED_ARTIFACT_STORE_PATH: tempArtifactStorePath(statePath),
      MSWARM_SELF_HOSTED_MODEL_ALLOWLIST: "phi3.5:3.8b,llama3.1:8b",
      MSWARM_SELF_HOSTED_EXPOSURE_POLICY: "none"
    } as NodeJS.ProcessEnv);
    expect(firstConfig.nodeId).toBe("shn_env");
    expect(firstConfig.discoveryMode).toBe("mcoda");
    expect(firstConfig.mcodaBin).toBe("mcoda");
    expect(firstConfig.requestTimeoutMs).toBe(10_000);
    expect(firstConfig.jobTimeoutMs).toBe(3_600_000);
    expect(firstConfig.artifactStorePath).toBe(tempArtifactStorePath(statePath));
    expect(firstConfig.maxConcurrentJobs).toBe(1);
    expect(firstConfig.maxConcurrentLlmJobs).toBe(1);
    expect(firstConfig.genericJobsEnabled).toBe(false);
    expect(firstConfig.genericJobTimeoutMs).toBe(3_600_000);
    expect(firstConfig.genericJobMaxConcurrency).toBe(1);
    expect(firstConfig.drainMode).toBe(false);
    expect(firstConfig.loadReportingEnabled).toBe(true);
    expect(firstConfig.hardwareTelemetryEnabled).toBe(false);
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
      MSWARM_SELF_HOSTED_JOB_TIMEOUT_MS: "7200000",
      MSWARM_SELF_HOSTED_MAX_CONCURRENT_JOBS: "4",
      MSWARM_SELF_HOSTED_MAX_CONCURRENT_LLM_JOBS: "2",
      MSWARM_SELF_HOSTED_GENERIC_JOBS_ENABLED: "true",
      MSWARM_SELF_HOSTED_GENERIC_JOB_TIMEOUT_MS: "5000",
      MSWARM_SELF_HOSTED_GENERIC_JOB_MAX_CONCURRENCY: "3",
      MSWARM_SELF_HOSTED_DRAIN_MODE: "true",
      MSWARM_SELF_HOSTED_LOAD_REPORTING_ENABLED: "false",
      MSWARM_SELF_HOSTED_HARDWARE_TELEMETRY_ENABLED: "true"
    } as NodeJS.ProcessEnv);

    expect(config.jobTimeoutMs).toBe(7_200_000);
    expect(config.maxConcurrentJobs).toBe(4);
    expect(config.maxConcurrentLlmJobs).toBe(2);
    expect(config.genericJobsEnabled).toBe(true);
    expect(config.genericJobTimeoutMs).toBe(5_000);
    expect(config.genericJobMaxConcurrency).toBe(3);
    expect(config.drainMode).toBe(true);
    expect(config.loadReportingEnabled).toBe(false);
    expect(config.hardwareTelemetryEnabled).toBe(true);
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
        "--artifact-store-path",
        tempArtifactStorePath(statePath),
        "--max-concurrent-jobs",
        "4",
        "--max-concurrent-llm-jobs",
        "2",
        "--generic-job-max-concurrency",
        "2",
        "--enable-hardware-telemetry",
        "--allow",
        "phi3-reviewer",
        "--clients",
        "heka,wodo,192.0.2.10,550E8400-E29B-41D4-A716-446655440000"
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
    expect(setupConfig.maxConcurrentJobs).toBe(4);
    expect(setupConfig.maxConcurrentLlmJobs).toBe(2);
    expect(setupConfig.genericJobMaxConcurrency).toBe(2);
    expect(setupConfig.drainMode).toBe(false);
    expect(setupConfig.loadReportingEnabled).toBe(true);
    expect(setupConfig.hardwareTelemetryEnabled).toBe(true);
    expect(setupConfig.artifactStorePath).toBe(tempArtifactStorePath(statePath));
    expect(setupConfig.exposeAllModels).toBe(true);
    expect(setupConfig.modelAllowlist).toEqual(["phi3-reviewer"]);
    expect(setupConfig.clientAllowlist).toEqual([
      { kind: "domain", value: "heka" },
      { kind: "domain", value: "wodo" },
      { kind: "ip", value: "192.0.2.10" },
      { kind: "uuid", value: "550e8400-e29b-41d4-a716-446655440000" }
    ]);

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

  it("parses node install positional clients without treating them as an API key", async () => {
    const statePath = tempStatePath();
    const machinePath = join(dirname(statePath), "machine.id");
    const setupArgs = await buildNodeInstallSetupArgs([
      "heka,wodo,192.0.2.10",
      "--api-key",
      "msw_owner",
      "--gateway",
      "https://gateway.test/",
      "--server-name",
      "Bekir MacBook Pro"
    ]);

    expect(setupArgs.slice(0, 2)).toEqual(["--clients", "heka,wodo,192.0.2.10"]);
    const setupConfig = await readOwnerSetupConfig(setupArgs, {
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath),
      MSWARM_SELF_HOSTED_MACHINE_ID_PATH: machinePath
    } as NodeJS.ProcessEnv);

    expect(setupConfig.apiKey).toBe("msw_owner");
    expect(setupConfig.clientAllowlist).toEqual([
      { kind: "domain", value: "heka" },
      { kind: "domain", value: "wodo" },
      { kind: "ip", value: "192.0.2.10" }
    ]);
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

  it("keeps self-hosted LLM invocation jobs accepted outside the generic job contract", async () => {
    const statePath = tempStatePath();
    let chatBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "http://ollama.test/api/chat") {
        chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          message: { content: "hello from llm" },
          prompt_eval_count: 2,
          eval_count: 3
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(serviceConfigFor(statePath), { fetchImpl });
    const llmJob: SelfHostedNodeInvocationJob = {
      job_id: "job-llm-compat",
      request_id: "req-llm-compat",
      node_id: "shn_service",
      agent_slug: "phi3-reviewer",
      provider: "ollama",
      model: "phi3.5:latest",
      openai_request: {
        model: "phi3.5:latest",
        messages: [{ role: "user", content: "Say hello." }]
      }
    };

    const result = await runtime.executeJob(llmJob);

    expect(result.status).toBe("success");
    assert.ok(chatBody);
    expect((chatBody as Record<string, unknown>).model).toBe("phi3.5:latest");
    expect((chatBody as Record<string, unknown>).stream).toBe(false);
    expect((result.openai_response?.choices as Array<{ message?: { content?: string } }>)[0]?.message?.content).toBe(
      "hello from llm"
    );
  });

  it("runs owner-local generic test.echo jobs through the generic runner path", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const runtime = new SelfHostedNodeRuntime(config);
    const events: Array<{ type: unknown }> = [];

    const result = await runtime.executeGenericJob(genericEchoJob(), {
      onEvent: async (event) => {
        events.push(event);
      }
    });

    expect(result.status).toBe("succeeded");
    expect(result.result.status).toBe("succeeded");
    expect(result.result.job_id).toBe("job-generic-echo");
    expect(result.events.length).toBe(events.length);
    expect(events.map((event) => event.type)).toEqual(["started", "stdout", "progress", "completed"]);
    expect(result.result.metrics).toMatchObject({
      runner: "test.echo",
      message: "hello generic"
    });
  });

  it("collects declared output artifacts from the local generic artifact store", async () => {
    const statePath = tempStatePath();
    class ArtifactWritingRunner implements MswarmGenericJobRunner {
      readonly id = "test.echo";

      async run(context: MswarmGenericJobRunnerContext) {
        mkdirSync(join(context.artifacts.outputDir, "frames"), { recursive: true });
        writeFileSync(join(context.artifacts.outputDir, "frames", "0001.txt"), "rendered frame\n");
        return {
          job_id: "runner-local-id",
          status: "succeeded" as const,
          exit_code: 0
        };
      }
    }
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath: tempArtifactStorePath(statePath)
      }),
      { genericRunners: [new ArtifactWritingRunner()] }
    );

    const result = await runtime.executeGenericJob(
      genericEchoJob({
        job: {
          ...genericEchoJob().job,
          outputs: [
            {
              name: "frame",
              path: "frames/0001.txt",
              content_type: "text/plain",
              required: true
            }
          ]
        }
      })
    );

    expect(result.status).toBe("succeeded");
    expect(result.events.map((event) => event.type)).toContain("artifact");
    expect(result.result.artifacts?.length).toBe(1);
    const artifact = result.result.artifacts?.[0];
    assert.ok(artifact);
    expect(artifact.name).toBe("frame");
    expect(artifact.uri).toBe("artifact://local/job-generic-echo/frames/0001.txt");
    expect(artifact.content_type).toBe("text/plain");
    expect(artifact.size_bytes).toBe(Buffer.byteLength("rendered frame\n"));
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.scope).toBe("output");
  });

  it("runs render.blender jobs through safe command args and artifact collection", async () => {
    const statePath = tempStatePath();
    const artifactStorePath = tempArtifactStorePath(statePath);
    mkdirSync(join(artifactStorePath, "upstream-render", "outputs"), { recursive: true });
    writeFileSync(join(artifactStorePath, "upstream-render", "outputs", "scene.blend"), "fake blend\n", "utf8");
    const captured: { args?: string[]; command?: string } = {};
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath,
        genericJobTimeoutMs: 2_000
      }),
      {
        capabilityRunner: blenderCapabilityAndRenderRunner(captured)
      }
    );

    const envelope = genericBlenderJob();
    const result = await runtime.executeGenericJob({
      ...envelope,
      job: {
        ...envelope.job,
        resources: {
          gpu: {
            count: 1,
            vendor: "nvidia"
          }
        }
      }
    });

    expect(result.status).toBe("succeeded");
    expect(captured.command).toBe("blender");
    assert.ok(captured.args);
    expect(captured.args).toContain("-b");
    expect(captured.args).toContain("--render-output");
    expect(captured.args).toContain("--render-format");
    expect(captured.args).toContain("PNG");
    expect(captured.args).toContain("--engine");
    expect(captured.args).toContain("CYCLES");
    expect(captured.args).toContain("-s");
    expect(captured.args).toContain("-e");
    expect(captured.args).toContain("-a");
    expect(captured.args).not.toContain("bash");
    const pythonExprIndex = captured.args.indexOf("--python-expr");
    assert.ok(pythonExprIndex >= 0);
    const pythonExpr = captured.args[pythonExprIndex + 1] || "";
    expect(pythonExpr).toContain("compute_device_type");
    expect(pythonExpr).toContain('"CUDA"');
    expect(pythonExpr).toContain("scene.cycles");
    expect(result.events.map((event) => event.type)).toContain("artifact");
    expect(result.events.map((event) => event.type)).toContain("progress");
    expect(result.result.artifacts?.length).toBe(1);
    expect(result.result.artifacts?.[0]?.uri).toBe("artifact://local/job-render-blender/frames/frame_0001.png");
    expect(result.result.metrics).toMatchObject({
      runner: "blender.render",
      frames: "1-2",
      engine: "cycles",
      output_format: "png",
      resolution: "640x360",
      gpu_requested: true,
      render_device: "gpu"
    });
    expect(JSON.stringify(result.result)).not.toContain(artifactStorePath);
    expect(JSON.stringify(result.events)).not.toContain(artifactStorePath);
  });

  it("rejects render.blender tenant-owned jobs until containerized Blender execution exists", async () => {
    const statePath = tempStatePath();
    const artifactStorePath = tempArtifactStorePath(statePath);
    mkdirSync(join(artifactStorePath, "upstream-render", "outputs"), { recursive: true });
    writeFileSync(join(artifactStorePath, "upstream-render", "outputs", "scene.blend"), "fake blend\n", "utf8");
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath,
        genericJobTimeoutMs: 2_000
      }),
      {
        capabilityRunner: blenderCapabilityAndRenderRunner({})
      }
    );
    const baseJob = genericBlenderJob();

    const result = await runtime.executeGenericJob(
      genericBlenderJob({
        job: {
          ...baseJob.job,
          policy: {
            trust_mode: "tenant-owned",
            network: "none",
            allow_raw_command: false
          }
        }
      })
    );

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("policy_denied");
  });

  it("rejects render.blender GPU requests instead of silently falling back to CPU", async () => {
    const statePath = tempStatePath();
    const captured: { args?: string[]; command?: string } = {};
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        genericJobTimeoutMs: 2_000
      }),
      {
        capabilityRunner: blenderCapabilityAndRenderRunner(captured)
      }
    );
    const baseJob = genericBlenderJob();

    const result = await runtime.executeGenericJob(
      genericBlenderJob({
        job: {
          ...baseJob.job,
          resources: {
            gpu: {
              count: 2,
              min_vram_gb: 8,
              vendor: "nvidia"
            }
          }
        }
      })
    );

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("no_capable_node");
    expect(captured.command).toBeUndefined();
  });

  it("runs cuda.run jobs through approved Docker NVIDIA args and artifact collection", async () => {
    const statePath = tempStatePath();
    const artifactStorePath = tempArtifactStorePath(statePath);
    writeCudaUpstreamArtifacts(artifactStorePath);
    const captured: { args?: string[]; command?: string } = {};
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath,
        genericJobTimeoutMs: 3_000
      }),
      {
        capabilityRunner: cudaCapabilityAndDockerRunner(captured)
      }
    );

    const result = await runtime.executeGenericJob(genericCudaJob());

    expect(result.status).toBe("succeeded");
    expect(captured.command).toBe("docker");
    assert.ok(captured.args);
    expect(captured.args).toContain("run");
    expect(captured.args).toContain("--runtime");
    expect(captured.args).toContain("nvidia");
    expect(captured.args).toContain("--gpus");
    expect(captured.args).toContain("count=1");
    expect(captured.args).toContain("--network");
    expect(captured.args).toContain("none");
    expect(captured.args).toContain("--user");
    expect(captured.args).toContain("65532:65532");
    expect(captured.args).toContain("--read-only");
    expect(captured.args).toContain("--cap-drop");
    expect(captured.args).toContain("ALL");
    expect(captured.args).toContain("--security-opt");
    expect(captured.args).toContain("no-new-privileges");
    expect(captured.args).toContain("--pull");
    expect(captured.args).toContain("never");
    expect(captured.args).toContain("nvidia/cuda:12.4.1-devel-ubuntu22.04");
    expect(captured.args).toContain("/bin/bash");
    expect(captured.args).toContain("/workspace/__mcoda_cuda_run.sh");
    expect(captured.args).not.toContain("--privileged");
    expect(captured.args).not.toContain("host");
    expect(captured.args).not.toContain("-lc");
    expect(captured.args.some((arg) => arg.includes(":/workspace/inputs:ro"))).toBe(true);
    expect(captured.args.some((arg) => arg.includes(":/workspace/outputs:rw"))).toBe(true);
    expect(captured.args.some((arg) => arg.includes(":/workspace/work:rw"))).toBe(true);
    expect(result.events.map((event) => event.type)).toContain("artifact");
    expect(result.events.map((event) => event.type)).toContain("stdout");
    expect(result.events.map((event) => event.type)).toContain("stderr");
    expect(result.result.artifacts?.length).toBe(1);
    expect(result.result.artifacts?.[0]?.uri).toBe("artifact://local/job-cuda-run/results/result.txt");
    expect(result.result.metrics).toMatchObject({
      runner: "cuda.package",
      image: "nvidia/cuda:12.4.1-devel-ubuntu22.04",
      profile: "nvcc-default",
      target: "vector-add",
      publisher: "mcoda.local",
      gpu_count: 1,
      network: "none",
      container_user: "65532:65532"
    });
    expect(JSON.stringify(result.result)).not.toContain(artifactStorePath);
    expect(JSON.stringify(result.events)).not.toContain(artifactStorePath);
  });

  it("rejects cuda.run manifests with raw commands or unapproved images", async () => {
    const statePath = tempStatePath();
    const artifactStorePath = tempArtifactStorePath(statePath);
    writeCudaUpstreamArtifacts(
      artifactStorePath,
      validCudaManifest({
        profiles: {
          "nvcc-default": {
            image: "nvidia/cuda:latest",
            compiler: "nvcc"
          }
        },
        targets: {
          "vector-add": {
            source: "src/vector_add.cu",
            command: "bash -lc ./run.sh"
          }
        }
      })
    );
    const captured: { args?: string[]; command?: string } = {};
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath,
        genericJobTimeoutMs: 3_000
      }),
      {
        capabilityRunner: cudaCapabilityAndDockerRunner(captured)
      }
    );

    const result = await runtime.executeGenericJob(genericCudaJob());

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("validation_failed");
    expect(result.result.error?.message || "").toContain("not_allowed");
    expect(captured.command).toBeUndefined();
  });

  it("rejects cuda.run packages with unsafe archive entries before Docker", async () => {
    const statePath = tempStatePath();
    const artifactStorePath = tempArtifactStorePath(statePath);
    writeCudaUpstreamArtifacts(artifactStorePath);
    const captured: { args?: string[]; command?: string } = {};
    const baseRunner = cudaCapabilityAndDockerRunner(captured);
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath,
        genericJobTimeoutMs: 3_000
      }),
      {
        capabilityRunner: async (command, args, options) => {
          if (command === "tar" && args[0] === "-tzf") {
            return { stdout: "../escape.cu\n", stderr: "" };
          }
          return baseRunner(command, args, options);
        }
      }
    );

    const result = await runtime.executeGenericJob(genericCudaJob());

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("validation_failed");
    expect(result.result.error?.message || "").toContain("cuda_package_archive_parent_path_not_allowed");
    expect(captured.command).toBeUndefined();
  });

  it("redacts local paths from cuda.run validation failures", async () => {
    const statePath = tempStatePath();
    const artifactStorePath = tempArtifactStorePath(statePath);
    writeCudaUpstreamArtifacts(artifactStorePath);
    const captured: { args?: string[]; command?: string } = {};
    const baseRunner = cudaCapabilityAndDockerRunner(captured);
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath,
        genericJobTimeoutMs: 3_000
      }),
      {
        capabilityRunner: async (command, args, options) => {
          if (command === "tar" && args[0] === "-tzf") {
            throw new Error(`tar failed while reading ${args[1]}`);
          }
          return baseRunner(command, args, options);
        }
      }
    );

    const result = await runtime.executeGenericJob(genericCudaJob());
    const message = result.result.error?.message || "";

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("validation_failed");
    expect(message).toContain("[job-input]");
    expect(message).not.toContain(artifactStorePath);
    expect(captured.command).toBeUndefined();
  });

  it("rejects cuda.run jobs when Docker NVIDIA is unavailable", async () => {
    const statePath = tempStatePath();
    const captured: { args?: string[]; command?: string } = {};
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        genericJobTimeoutMs: 3_000
      }),
      {
        capabilityRunner: async (command, args) => {
          if (command === "nvidia-smi" && args.length === 0) {
            return { stdout: "NVIDIA-SMI 550.54.14    CUDA Version: 12.4\n", stderr: "" };
          }
          if (command === "nvidia-smi") {
            return { stdout: "0, NVIDIA RTX 4090, 24564, 550.54.14, 8.9\n", stderr: "" };
          }
          if (command === "docker" && args[0] === "info") {
            return { stdout: JSON.stringify({ runc: { path: "runc" } }), stderr: "" };
          }
          if (command === "blender" && args.includes("--version")) {
            return { stdout: "Blender 4.1.1\n", stderr: "" };
          }
          if (command === "ffmpeg") {
            return { stdout: "ffmpeg version 6.1 Copyright\n", stderr: "" };
          }
          captured.command = command;
          captured.args = [...args];
          return { stdout: "", stderr: "" };
        }
      }
    );

    const result = await runtime.executeGenericJob(genericCudaJob());

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("no_capable_node");
    expect(result.result.error?.message || "").toContain("NVIDIA runtime");
    expect(captured.command).toBeUndefined();
  });

  it("registers input artifact metadata without exposing host paths in job results", async () => {
    const statePath = tempStatePath();
    const captured: { context?: MswarmGenericJobRunnerContext } = {};
    class InputInspectingRunner implements MswarmGenericJobRunner {
      readonly id = "test.echo";

      async run(context: MswarmGenericJobRunnerContext) {
        captured.context = context;
        return {
          job_id: "runner-local-id",
          status: "succeeded" as const,
          exit_code: 0
        };
      }
    }
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath: tempArtifactStorePath(statePath)
      }),
      { genericRunners: [new InputInspectingRunner()] }
    );

    const result = await runtime.executeGenericJob(
      genericEchoJob({
        job: {
          ...genericEchoJob().job,
          inputs: [
            {
              name: "scene",
              artifact: {
                uri: "artifact://local/upstream-job/scene.blend",
                content_type: "application/octet-stream",
                size_bytes: 128
              },
              mount_path: "scene/scene.blend",
              required: false
            }
          ]
        }
      })
    );

    expect(result.status).toBe("succeeded");
    assert.ok(captured.context);
    expect(captured.context.artifacts.registeredInputs).toHaveLength(1);
    expect(captured.context.artifacts.registeredInputs[0]?.store.backend).toBe("local-dev");
    expect(captured.context.artifacts.registeredInputs[0]?.access.visibility).toBe("owner-local");
    expect(captured.context.artifacts.registeredInputs[0]?.retention.retain_for_seconds).toBe(86_400);
    expect(JSON.stringify(result.result)).not.toContain(tempArtifactStorePath(statePath));
  });

  it("rejects unsafe generic output paths before runner execution", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(genericServiceConfigFor(statePath));

    const result = await runtime.executeGenericJob(
      genericEchoJob({
        job: {
          ...genericEchoJob().job,
          outputs: [
            {
              name: "escape",
              path: "../escape.txt",
              required: true
            }
          ]
        }
      })
    );

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("validation_failed");
    expect(result.validation_issues?.[0]?.code).toBe("unsafe_path");
  });

  it("passes non-root container sandbox defaults to tenant-owned GPU generic jobs", async () => {
    const statePath = tempStatePath();
    const captured: { context?: MswarmGenericJobRunnerContext } = {};
    class SandboxInspectingRunner implements MswarmGenericJobRunner {
      readonly id = "test.echo";

      async run(context: MswarmGenericJobRunnerContext) {
        captured.context = context;
        return {
          job_id: "runner-local-id",
          status: "succeeded" as const,
          exit_code: 0
        };
      }
    }
    const runtime = new SelfHostedNodeRuntime(genericServiceConfigFor(statePath), {
      genericRunners: [new SandboxInspectingRunner()]
    });

    const result = await runtime.executeGenericJob(
      genericEchoJob({
        job: {
          ...genericEchoJob().job,
          policy: {
            trust_mode: "tenant-owned",
            network: "none",
            allow_raw_command: false,
            allowed_images: ["nvidia/cuda:12.4.1-devel-ubuntu22.04"]
          },
          resources: {
            gpu: {
              count: 1,
              vendor: "nvidia"
            }
          }
        }
      })
    );

    expect(result.status).toBe("succeeded");
    assert.ok(captured.context);
    expect(captured.context.sandbox.name).toBe("container-nvidia");
    expect(captured.context.sandbox.container.enabled).toBe(true);
    expect(captured.context.sandbox.container.rootless).toBe(true);
    expect(captured.context.sandbox.container.user).toBe("65532:65532");
    expect(captured.context.sandbox.container.privileged).toBe(false);
    expect(captured.context.sandbox.filesystem.allow_host_paths).toBe(false);
    expect(result.events[0]?.data?.sandbox_profile).toBe("container-nvidia");
  });

  it("rejects symlinked generic outputs during local artifact collection", async () => {
    const statePath = tempStatePath();
    class SymlinkOutputRunner implements MswarmGenericJobRunner {
      readonly id = "test.echo";

      async run(context: MswarmGenericJobRunnerContext) {
        writeFileSync(join(context.artifacts.workDir, "outside.txt"), "escape\n");
        symlinkSync(join(context.artifacts.workDir, "outside.txt"), join(context.artifacts.outputDir, "link.txt"));
        return {
          job_id: "runner-local-id",
          status: "succeeded" as const,
          exit_code: 0
        };
      }
    }
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath: tempArtifactStorePath(statePath)
      }),
      { genericRunners: [new SymlinkOutputRunner()] }
    );

    const result = await runtime.executeGenericJob(
      genericEchoJob({
        job: {
          ...genericEchoJob().job,
          outputs: [
            {
              name: "link",
              path: "link.txt",
              required: true
            }
          ]
        }
      })
    );

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("runner_error");
    expect(result.result.error?.message).toBe("output_symlink_not_allowed");
  });

  it("does not mask failed runner results with missing required outputs", async () => {
    const statePath = tempStatePath();
    class FailedRunner implements MswarmGenericJobRunner {
      readonly id = "test.echo";

      async run() {
        return {
          job_id: "runner-local-id",
          status: "failed" as const,
          exit_code: 1,
          error: {
            code: "runner_failed",
            message: "runner reported failure"
          }
        };
      }
    }
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        artifactStorePath: tempArtifactStorePath(statePath)
      }),
      { genericRunners: [new FailedRunner()] }
    );

    const result = await runtime.executeGenericJob(
      genericEchoJob({
        job: {
          ...genericEchoJob().job,
          outputs: [
            {
              name: "required-missing",
              path: "missing.txt",
              required: true
            }
          ]
        }
      })
    );

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("runner_failed");
    expect(result.result.error?.message).toBe("runner reported failure");
  });

  it("keeps generic jobs disabled by default in runtime execution", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(serviceConfigFor(statePath));

    const result = await runtime.executeGenericJob(genericEchoJob());

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("feature_disabled");
  });

  it("cancels generic jobs through abort signals", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(genericServiceConfigFor(statePath, { genericJobTimeoutMs: 2_000 }));
    const controller = new AbortController();
    const events: Array<{ type: unknown }> = [];

    const result = await runtime.executeGenericJob(
      genericEchoJob({
        job: {
          ...genericEchoJob().job,
          args: {
            message: "slow",
            delay_ms: 20,
            repeat: 5
          },
          limits: {
            timeout_sec: 2
          }
        }
      }),
      {
        signal: controller.signal,
        onEvent: async (event) => {
          events.push(event);
          if (event.type === "stdout") {
            controller.abort("cancelled");
          }
        }
      }
    );

    expect(result.status).toBe("cancelled");
    expect(result.result.error?.code).toBe("cancelled");
    expect(events.map((event) => event.type)).toContain("cancelled");
  });

  it("times out generic jobs using runtime timeout plumbing", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(genericServiceConfigFor(statePath, { genericJobTimeoutMs: 10 }));

    const result = await runtime.executeGenericJob(
      genericEchoJob({
        job: {
          ...genericEchoJob().job,
          args: {
            message: "too slow",
            delay_ms: 50,
            repeat: 2
          }
        }
      })
    );

    expect(result.status).toBe("failed");
    expect(result.result.error?.code).toBe("timeout");
    expect(result.events.map((event) => event.type)).toContain("failed");
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

  it("forwards runtime tool contracts from self-hosted jobs to Codali metadata", async () => {
    const statePath = tempStatePath();
    const captured: { value?: MswarmCodaliInvocationInput } = {};
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([healthyMcodaAgent({ supportsTools: true })]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        captured.value = input;
        const invocation = successfulCodaliInvocation(input, "contract ok");
        invocation.metadata = {
          ...invocation.metadata,
          tool_calls_executed: 1,
          called_tools: ["app_daily_logs"],
          dynamic_tools_considered: ["docdex_search", "app_daily_logs"],
          dynamic_tools_registered: ["app_daily_logs"],
          dynamic_tools_skipped: [],
          tool_call_details: [
            {
              name: "app_daily_logs",
              backingTool: "docdex_search",
              status: "success",
              latencyMs: 5
            }
          ],
          telemetry: {
            runId: invocation.metadata.run_id,
            runtime: "codali",
            mode: invocation.metadata.mode,
            toolCallCount: 1,
            calledTools: ["app_daily_logs"],
            consideredTools: ["docdex_search", "app_daily_logs"],
            registeredDynamicTools: ["app_daily_logs"],
            skippedDynamicTools: [],
            dynamicToolCalls: [
              {
                name: "app_daily_logs",
                backingTool: "docdex_search",
                status: "success",
                latencyMs: 5
              }
            ],
            warnings: []
          }
        };
        return invocation;
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-runtime-contracts",
      request_id: "req-runtime-contracts",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      execution_runtime: "codali",
      workspace: {
        root: "/tmp/workspace",
        read_only: true
      },
      docdex: {
        base_url: "http://docdex.test",
        repo_root: "/tmp/workspace",
        tool_manifest: {
          actualTools: ["docdex_search"],
          virtualTools: ["app_daily_logs"]
        },
        allow_web: false,
        allow_memory_write: false,
        allow_profile_write: false,
        allow_index_rebuild: false
      },
      policy: {
        allowed_tools: ["docdex_search", "app_daily_logs"],
        denied_tools: ["github_search"],
        app_tool_contracts: {
          generic_tenant_lookup: {
            executionMode: "server_supplied_snapshot_plus_docdex",
            callSchema: { type: "object" },
            backingTools: ["docdex_search"]
          },
          app_daily_logs: {
            executionMode: "server_supplied_snapshot_plus_docdex",
            callSchema: { type: "object" },
            resultContract: "daily log search results",
            backingTools: ["docdex_search"]
          }
        },
        app_virtual_tools: ["app_daily_logs"],
        allow_shell: false,
        allow_writes: false,
        max_tool_calls: 5
      },
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "What changed in daily logs?" }]
      }
    });

    expect(result.status).toBe("success");
    const capturedInput = captured.value;
    assert.ok(capturedInput);
    expect(capturedInput.docdex?.toolManifest).toEqual({
      actualTools: ["docdex_search"],
      virtualTools: ["app_daily_logs"]
    });
    expect(capturedInput.policy?.allowedTools).toEqual(["docdex_search", "app_daily_logs"]);
    expect(capturedInput.policy?.deniedTools).toEqual(["github_search"]);
    assert.deepEqual(capturedInput.policy?.appToolContracts, {
      generic_tenant_lookup: {
        executionMode: "server_supplied_snapshot_plus_docdex",
        callSchema: { type: "object" },
        backingTools: ["docdex_search"]
      },
      app_daily_logs: {
        executionMode: "server_supplied_snapshot_plus_docdex",
        callSchema: { type: "object" },
        resultContract: "daily log search results",
        backingTools: ["docdex_search"]
      }
    });
    expect(capturedInput.policy?.appVirtualTools).toEqual(["app_daily_logs"]);
    const metadata = (result.openai_response?.metadata as Record<string, unknown>) || {};
    expect(metadata.runtime).toBe("codali");
    expect(metadata.called_tools).toEqual(["app_daily_logs"]);
    expect(metadata.dynamic_tools_registered).toEqual(["app_daily_logs"]);
    assert.equal((metadata.tool_call_details as Array<{ backingTool?: string }>)[0]?.backingTool, "docdex_search");
  });

  it("forwards codali_job payloads through Codali and preserves job telemetry", async () => {
    const statePath = tempStatePath();
    const captured: { value?: MswarmCodaliInvocationInput } = {};
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([healthyMcodaAgent({ supportsTools: true })]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        captured.value = input;
        await input.onJobEvent?.({
          type: "stage_start",
          jobId: "job-codali-job",
          stageId: "worker",
          kind: "worker",
          at: "2026-07-01T00:00:00.000Z"
        });
        const invocation = successfulCodaliInvocation(input, "job answer");
        invocation.metadata = {
          ...invocation.metadata,
          tool_calls_executed: 1,
          called_tools: ["tenant_daily_logs"],
          dynamic_tools_considered: ["docdex_search", "tenant_daily_logs"],
          codali_job_id: "job-codali-job",
          codali_job_type: "tenant_chat",
          codali_job_status: "succeeded",
          codali_job_stage_count: 2,
          codali_job_stages: [
            {
              id: "worker",
              kind: "worker",
              status: "completed",
              attempt: 1,
              durationMs: 7,
              toolCallsExecuted: 1
            }
          ],
          codali_job_errors: [],
          telemetry: {
            runId: "run-job-codali-job",
            runtime: "codali",
            mode: "job",
            jobId: "job-codali-job",
            jobType: "tenant_chat",
            status: "succeeded",
            stageCount: 2,
            toolCallCount: 1,
            calledTools: ["tenant_daily_logs"],
            consideredTools: ["docdex_search", "tenant_daily_logs"],
            warnings: [],
            errors: [],
            stages: [
              {
                id: "worker",
                kind: "worker",
                status: "completed",
                attempt: 1,
                durationMs: 7,
                toolCallsExecuted: 1
              }
            ]
          }
        };
        return invocation;
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-codali-job",
      request_id: "req-codali-job",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      execution_runtime: "codali",
      workspace: {
        root: "/tmp/workspace",
        read_only: true
      },
      docdex: {
        base_url: "http://docdex.test",
        repo_root: "/tmp/workspace",
        tool_manifest: {
          actualTools: ["docdex_search"],
          virtualTools: ["tenant_daily_logs"]
        }
      },
      codali_job: {
        job_type: "tenant_chat",
        input: { question: "What changed?" },
        stages: [
          { id: "worker", kind: "worker", role: "evidence_collector", max_tool_calls: 1 },
          { id: "synth", kind: "synthesizer", depends_on: ["worker"], max_tool_calls: 0 }
        ],
        budgets: {
          max_tool_calls: 1,
          max_parallel_stages: 1
        }
      },
      policy: {
        allowed_tools: ["docdex_search", "tenant_daily_logs"],
        allow_shell: false,
        allow_writes: false,
        max_tool_calls: 3
      },
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "What changed?" }]
      }
    });

    expect(result.status).toBe("success");
    const capturedInput = captured.value;
    assert.ok(capturedInput);
    expect(capturedInput.codaliJob?.jobType).toBe("tenant_chat");
    expect(capturedInput.codaliJob?.id).toBe("job-codali-job");
    expect(capturedInput.codaliJob?.stages?.[0]?.role).toBe("evidence_collector");
    expect(capturedInput.codaliJob?.stages?.[0]?.maxToolCalls).toBe(1);
    expect(capturedInput.codaliJob?.stages?.[1]?.dependsOn).toEqual(["worker"]);
    expect(capturedInput.codaliJob?.budgets?.maxToolCalls).toBe(1);
    expect(capturedInput.codaliJob?.toolManifest).toEqual({
      actualTools: ["docdex_search"],
      virtualTools: ["tenant_daily_logs"]
    });
    const metadata = (result.openai_response?.metadata as Record<string, unknown>) || {};
    expect(metadata.codali_job_status).toBe("succeeded");
    expect(metadata.codali_job_stage_count).toBe(2);
    expect(metadata.called_tools).toEqual(["tenant_daily_logs"]);
    expect(result.progress_events?.some((event) => event.type === "stage_start" && event.stage_id === "worker")).toBe(true);
  });

  it("forwards codali_gateway payloads through Codali and preserves gateway telemetry", async () => {
    const statePath = tempStatePath();
    const captured: { value?: MswarmCodaliInvocationInput } = {};
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          supportsTools: true,
          supportsJsonSchema: true,
          capabilities: ["final_answer_synthesis"],
          contextWindow: 131_072
        })
      ]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        captured.value = input;
        await input.onGatewayEvent?.({
          type: "gateway_start",
          runId: "job-codali-gateway",
          mode: "balanced",
          at: "2026-07-02T00:00:00.000Z"
        });
        await input.onGatewayEvent?.({
          type: "gateway_result",
          runId: "run-codali-gateway",
          status: "succeeded",
          mode: "balanced",
          tool_call_count: 1,
          model_call_count: 4,
          source_count: 1,
          evidence_count: 1,
          at: "2026-07-02T00:00:01.000Z"
        });
        const invocation = successfulCodaliInvocation(input, "gateway answer");
        invocation.metadata = {
          ...invocation.metadata,
          tool_calls_executed: 1,
          called_tools: ["tenant_daily_logs"],
          dynamic_tools_considered: ["docdex_search", "tenant_daily_logs"],
          telemetry: {
            runId: "run-codali-gateway",
            runtime: "codali",
            mode: "gateway",
            status: "succeeded",
            toolCallCount: 1,
            modelCallCount: 4,
            taskCount: 1,
            calledTools: ["tenant_daily_logs"],
            consideredTools: ["docdex_search", "tenant_daily_logs"],
            warnings: [],
            errors: [],
            sourceCount: 1,
            evidenceCount: 1
          },
          codali_gateway_id: "run-codali-gateway",
          codali_gateway_status: "succeeded",
          codali_gateway_mode: "balanced",
          codali_gateway_task_count: 1,
          codali_gateway_tool_call_count: 1,
          codali_gateway_model_call_count: 4,
          codali_gateway_source_count: 1,
          codali_gateway_evidence_count: 1,
          codali_gateway_warnings: [],
          codali_gateway_errors: [],
          codali_gateway_trace: {
            runId: "run-codali-gateway",
            mode: "balanced",
            status: "succeeded",
            iterations: 1,
            toolCallCount: 1,
            modelCallCount: 4,
            consideredTools: ["docdex_search", "tenant_daily_logs"],
            calledTools: ["tenant_daily_logs"],
            warnings: [],
            errors: [],
            toolCalls: [{ tool: "tenant_daily_logs", status: "success" }],
            modelCalls: [],
            events: []
          },
          feedback_submission: {
            schema_version: MSWARM_CODALI_FEEDBACK_SUBMISSION_SCHEMA_VERSION,
            run_id: "run-codali-gateway",
            deletion_group_id: "delete-group-run-codali-gateway",
            target: {
              record_type: "gateway_record",
              record_id: "run-codali-gateway",
              role: "codali_gateway_answer"
            },
            candidate_records: [
              {
                record_type: "gateway_record",
                record_id: "run-codali-gateway",
                role: "codali_gateway_answer"
              }
            ],
            product_scope: {
              product_id: "product-alpha",
              tenant_scope_present: true
            },
            requester_scope: {
              visibility: "requester",
              tenant_wide: false,
              requester_hash: "requester-scope-hash"
            },
            source: {
              runtime: "mswarm",
              job_id: "job-codali-gateway",
              request_id: "req-codali-gateway",
              agent_slug: "qwen-reviewer",
              session_id: "tenant-chat-session"
            },
            raw_trace_included: false
          },
          codali_product_metadata: {
            schema_version: MSWARM_CODALI_PRODUCT_METADATA_SCHEMA_VERSION,
            run_id: "run-codali-gateway",
            trace_id: "trace-run-codali-gateway",
            context_pack_id: "ctx-run-codali-gateway",
            dataset_collection: {
              accepted: true,
              status: "queued",
              record_count: 1,
              object_count: 0
            },
            privacy_flags: {
              local_only: true,
              upload_allowed: false,
              export_allowed: false,
              training_allowed: false,
              raw_trace_included: false,
              contains_personal_data: true,
              contains_tenant_private_data: true,
              contains_customer_data: true
            },
            record_counts: {
              dataset_records: 1,
              sources: 1,
              evidence: 1,
              tool_calls: 1,
              model_calls: 4,
              context_packs: 1,
              final_answers: 1,
              warnings: 0,
              errors: 0
            },
            feedback_ref: {
              schema_version: MSWARM_CODALI_FEEDBACK_SUBMISSION_SCHEMA_VERSION,
              run_id: "run-codali-gateway",
              deletion_group_id: "delete-group-run-codali-gateway",
              target: {
                record_type: "gateway_record",
                record_id: "run-codali-gateway",
                role: "codali_gateway_answer"
              },
              candidate_record_count: 1,
              requester_scope: {
                visibility: "requester",
                tenant_wide: false,
                requester_hash: "requester-scope-hash"
              },
              raw_trace_included: false
            },
            called_tools: ["tenant_daily_logs"],
            model_tiers: [{ role: "final_synthesizer", tier: "large" }],
            warnings: [],
            errors: [],
            latency_ms: 25,
            latency: { total_ms: 25, model_ms: 20, tool_ms: 5 }
          },
          session_id: "tenant-chat-session"
        };
        return invocation;
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-codali-gateway",
      request_id: "req-codali-gateway",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      execution_runtime: "codali",
      workspace: {
        root: "/tmp/workspace",
        read_only: true
      },
      session: {
        id: "tenant-chat-session"
      },
      docdex: {
        base_url: "https://docdex.tenant.test",
        repo_root: "/tmp/workspace",
        repo_id: "repo-tenant-a",
        credential_source: "attached_mswarm_api_key",
        required: true,
        allowed_operations: ["search", "open"],
        tool_manifest: {
          actualTools: ["docdex_search"],
          virtualTools: ["tenant_daily_logs"]
        }
      },
      codali_gateway: {
        query: "What changed in tenant logs?",
        mode: "balanced",
        product: { id: "product-alpha" },
        tenant: { id: "tenant-a" },
        requester: {
          requesterHash: "requester-scope-hash",
          visibility: "tenant"
        },
        policy: {
          max_model_calls: 6,
          require_final_large_model: false
        },
        response: { format: "text" }
      },
      policy: {
        allowed_tools: ["docdex_search", "tenant_daily_logs"],
        denied_tools: ["github_search"],
        app_tool_contracts: {
          tenant_daily_logs: {
            executionMode: "server_supplied_snapshot_plus_docdex",
            callSchema: { type: "object" },
            resultContract: "daily log search results",
            backingTools: ["docdex_search"]
          }
        },
        app_virtual_tools: ["tenant_daily_logs"],
        allow_shell: false,
        allow_writes: false,
        max_tool_calls: 4
      },
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "What changed in tenant logs?" }]
      }
    }, { attachedMswarmApiKey: "attached-secret" });

    expect(result.status).toBe("success");
    const capturedInput = captured.value;
    assert.ok(capturedInput);
    expect(capturedInput.codaliGateway?.id).toBe("job-codali-gateway");
    expect(capturedInput.codaliGateway?.query).toBe("What changed in tenant logs?");
    expect(capturedInput.codaliGateway?.docdex?.baseUrl).toBe("https://docdex.tenant.test");
    expect(capturedInput.codaliGateway?.docdex?.repoId).toBe("repo-tenant-a");
    expect(capturedInput.codaliGateway?.tools).toEqual({
      actualTools: ["docdex_search"],
      virtualTools: ["tenant_daily_logs"]
    });
    expect(capturedInput.codaliGateway?.conversation?.id).toBe("tenant-chat-session");
    expect(capturedInput.session?.id).toBe("tenant-chat-session");
    expect(capturedInput.attachedMswarmApiKey).toBe("attached-secret");
    expect(capturedInput.policy?.allowedTools).toEqual(["docdex_search", "tenant_daily_logs"]);
    expect(capturedInput.policy?.appVirtualTools).toEqual(["tenant_daily_logs"]);
    const metadata = (result.openai_response?.metadata as Record<string, unknown>) || {};
    expect(metadata.codali_gateway_status).toBe("succeeded");
    expect(metadata.codali_gateway_task_count).toBe(1);
    expect(metadata.codali_gateway_source_count).toBe(1);
    expect(metadata.codali_gateway_evidence_count).toBe(1);
    expect(metadata.called_tools).toEqual(["tenant_daily_logs"]);
    expect(metadata.session_id).toBe("tenant-chat-session");
    const feedbackSubmission = metadata.feedback_submission as Record<string, unknown>;
    expect(feedbackSubmission.schema_version).toBe(MSWARM_CODALI_FEEDBACK_SUBMISSION_SCHEMA_VERSION);
    expect(feedbackSubmission.run_id).toBe("run-codali-gateway");
    expect(feedbackSubmission.raw_trace_included).toBe(false);
    expect(JSON.stringify(feedbackSubmission)).not.toContain("toolCalls");
    expect(JSON.stringify(feedbackSubmission)).not.toContain("codali_gateway_trace");
    expect((feedbackSubmission.requester_scope as Record<string, unknown>).visibility).toBe("requester");
    expect((feedbackSubmission.requester_scope as Record<string, unknown>).tenant_wide).toBe(false);
    const productMetadata = metadata.codali_product_metadata as Record<string, unknown>;
    expect(productMetadata.schema_version).toBe(MSWARM_CODALI_PRODUCT_METADATA_SCHEMA_VERSION);
    expect(productMetadata.run_id).toBe("run-codali-gateway");
    expect(productMetadata.trace_id).toBe("trace-run-codali-gateway");
    expect(productMetadata.context_pack_id).toBe("ctx-run-codali-gateway");
    expect((productMetadata.dataset_collection as Record<string, unknown>).status).toBe("queued");
    expect((productMetadata.dataset_collection as Record<string, unknown>).record_count).toBe(1);
    expect((productMetadata.privacy_flags as Record<string, unknown>).local_only).toBe(true);
    expect((productMetadata.privacy_flags as Record<string, unknown>).upload_allowed).toBe(false);
    expect((productMetadata.feedback_ref as Record<string, unknown>).deletion_group_id).toBe(
      "delete-group-run-codali-gateway"
    );
    expect(JSON.stringify(productMetadata)).not.toContain("private-dataset-id");
    expect(JSON.stringify(productMetadata)).not.toContain("private-batch-id");
    expect(result.progress_events?.some((event) => event.type === "gateway_start")).toBe(true);
    expect(result.progress_events?.some((event) => event.type === "gateway_result" && event.codali_gateway_id === "run-codali-gateway")).toBe(true);
  });

  it("fails before start when the selected mcoda agent is missing instead of substituting by model", async () => {
    const statePath = tempStatePath();
    let invoked = false;
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          slug: "fallback-same-model",
          defaultModel: "mcoda-selected-agent"
        })
      ]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        invoked = true;
        return successfulCodaliInvocation(input);
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-missing-selected-agent",
      request_id: "req-missing-selected-agent",
      node_id: "shn_service",
      agent_slug: "mcoda-selected-agent",
      source_agent_slug: "selected-agent",
      provider: "mcoda",
      model: "mcoda-selected-agent",
      openai_request: {
        model: "mcoda-selected-agent",
        messages: [{ role: "user", content: "Run on the selected agent." }]
      }
    });

    expect(result.status).toBe("failed");
    expect(result.pre_start_failure).toBe(true);
    expect(result.error?.code).toBe("selected_agent_unavailable");
    expect(invoked).toBe(false);
  });

  it("fails before start when the selected mcoda agent is unhealthy", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          slug: "qwen-reviewer",
          health: { status: "unhealthy" }
        })
      ]),
      codaliExecutor: new StubCodaliExecutor(async (input) => successfulCodaliInvocation(input))
    });

    const result = await runtime.executeJob({
      job_id: "job-unhealthy-selected-agent",
      request_id: "req-unhealthy-selected-agent",
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      provider: "mcoda",
      model: "mcoda-qwen-reviewer",
      openai_request: {
        model: "mcoda-qwen-reviewer",
        messages: [{ role: "user", content: "Run on the unhealthy agent." }]
      }
    });

    expect(result.status).toBe("failed");
    expect(result.pre_start_failure).toBe(true);
    expect(result.error?.code).toBe("selected_agent_unhealthy");
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

  it("normalizes OpenAI API mcoda agents to the Codali OpenAI-compatible provider", async () => {
    const statePath = tempStatePath();
    const captured: { value?: MswarmCodaliInvocationInput } = {};
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          id: "agent-qwen36-llama-cpp",
          slug: "qwen3.6-llama.cpp",
          adapter: "openai-api",
          defaultModel: "qwen3.6-llama.cpp",
          supportsTools: false,
          config: {
            baseUrl: "http://127.0.0.1:8080/v1",
            authMode: "bearer"
          }
        })
      ]),
      mcodaAgentAuthResolver: async (agent) =>
        agent.id === "agent-qwen36-llama-cpp" ? "stored-local-openai-key" : undefined,
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        captured.value = input;
        return successfulCodaliInvocation(input);
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-mcoda-openai-api",
      request_id: "req-mcoda-openai-api",
      node_id: "shn_service",
      agent_slug: "qwen3.6-llama.cpp",
      source_agent_slug: "qwen3.6-llama.cpp",
      provider: "mcoda",
      model: "mcoda-qwen3.6-llama.cpp",
      openai_request: {
        model: "mcoda-qwen3.6-llama.cpp",
        messages: [{ role: "user", content: "Return OK." }]
      },
      policy: {
        allow_tools: true,
        allowed_tools: ["docdex_search"]
      }
    });

    expect(result.status).toBe("success");
    const capturedInput = captured.value;
    assert.ok(capturedInput);
    expect(capturedInput.agent.adapter).toBe("openai-api");
    expect(capturedInput.agent.provider).toBe("openai-compatible");
    expect(capturedInput.agent.model).toBe("qwen3.6-llama.cpp");
    expect(capturedInput.agent.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(capturedInput.agent.authMode).toBe("bearer");
    expect(capturedInput.agent.apiKey).toBe("stored-local-openai-key");
    expect(JSON.stringify(result)).not.toContain("stored-local-openai-key");
  });

  it("fails before start when an OpenAI API mcoda agent requires auth but no secret is available", async () => {
    const statePath = tempStatePath();
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          id: "agent-qwen36-missing-auth",
          slug: "qwen3.6-llama.cpp",
          adapter: "openai-api",
          defaultModel: "qwen3.6-llama.cpp",
          supportsTools: false,
          config: {
            baseUrl: "http://127.0.0.1:8080/v1",
            authMode: "bearer"
          }
        })
      ]),
      mcodaAgentAuthResolver: async () => undefined,
      codaliExecutor: new StubCodaliExecutor(async () => {
        throw new Error("codali should not be invoked without local agent auth");
      })
    });

    const result = await runtime.executeJob({
      job_id: "job-mcoda-openai-api-missing-auth",
      request_id: "req-mcoda-openai-api-missing-auth",
      node_id: "shn_service",
      agent_slug: "qwen3.6-llama.cpp",
      source_agent_slug: "qwen3.6-llama.cpp",
      provider: "mcoda",
      model: "mcoda-qwen3.6-llama.cpp",
      openai_request: {
        model: "mcoda-qwen3.6-llama.cpp",
        messages: [{ role: "user", content: "Return OK." }]
      }
    });

    expect(result.status).toBe("failed");
    expect(result.pre_start_failure).toBe(true);
    expect(result.error?.code).toBe("selected_agent_auth_unavailable");
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
        scheduling: { fairness_key: "theneuralledger" },
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
    expect(capturedInput.docdex?.clientIdentity).toBe("theneuralledger");
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
    const startPosts: Record<string, unknown>[] = [];
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
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-docdex-relay/start") {
        startPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ accepted: true, status: "started" });
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
    expect(startPosts).toHaveLength(1);
    expect(startPosts[0]).toMatchObject({
      node_id: "shn_service",
      agent_slug: "qwen-reviewer",
      source_agent_slug: "qwen-reviewer",
      model: "mcoda-qwen-reviewer"
    });
    assert.ok(postedResult);
    expect(JSON.stringify(postedResult)).not.toContain(secret);
  });

  it("uses relay lifecycle metadata for outbound job calls", async () => {
    const statePath = tempStatePath();
    const seenUrls: string[] = [];
    let postedResult: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      seenUrls.push(target);
      if (target === "https://relay.test/custom/node/jobs/poll") {
        return jsonResponse({
          job: {
            job_id: "job-custom-lifecycle",
            request_id: "req-custom-lifecycle",
            node_id: "shn_service",
            agent_slug: "qwen-reviewer",
            source_agent_slug: "qwen-reviewer",
            provider: "mcoda",
            model: "mcoda-qwen-reviewer",
            openai_request: {
              model: "mcoda-qwen-reviewer",
              messages: [{ role: "user", content: "Use relay lifecycle metadata." }]
            }
          }
        });
      }
      if (target === "https://relay.test/custom/node/jobs/job-custom-lifecycle/start") {
        return jsonResponse({ accepted: true, status: "started" });
      }
      if (target === "https://relay.test/custom/node/jobs/job-custom-lifecycle/result") {
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(
      {
        ...permissiveServiceConfigFor(statePath),
        gatewayBaseUrl: "https://relay.test",
        jobsPollPath: "/custom/node/jobs/poll",
        jobsStartPathTemplate: "/custom/node/jobs/:jobId/start",
        jobsEventsPathTemplate: "/custom/node/jobs/:jobId/events",
        jobsResultPathTemplate: "/custom/node/jobs/:jobId/result"
      },
      {
        fetchImpl,
        mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
        codaliExecutor: new StubCodaliExecutor(async (input) => successfulCodaliInvocation(input, "metadata ok"))
      }
    );

    const result = await runtime.pollAndExecuteJob(1);

    expect(result.executed).toBe(true);
    expect(result.status).toBe("success");
    expect(seenUrls).toContain("https://relay.test/custom/node/jobs/poll");
    expect(seenUrls).toContain("https://relay.test/custom/node/jobs/job-custom-lifecycle/start");
    expect(seenUrls).toContain("https://relay.test/custom/node/jobs/job-custom-lifecycle/result");
    const posted = postedResult as Record<string, unknown> | null;
    assert.ok(posted);
    expect((posted.usage as { total_tokens?: number } | undefined)?.total_tokens).toBe(13);
  });

  it("retries transient outbound relay result post failures", async () => {
    const statePath = tempStatePath();
    let resultAttempts = 0;
    let postedResult: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/poll") {
        return jsonResponse({
          job: {
            job_id: "job-result-retry",
            request_id: "req-result-retry",
            node_id: "shn_service",
            agent_slug: "qwen-reviewer",
            source_agent_slug: "qwen-reviewer",
            provider: "mcoda",
            model: "mcoda-qwen-reviewer",
            openai_request: {
              model: "mcoda-qwen-reviewer",
              messages: [{ role: "user", content: "Retry result posting." }]
            }
          }
        });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-result-retry/start") {
        return jsonResponse({ accepted: true, status: "started" });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-result-retry/result") {
        resultAttempts += 1;
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (resultAttempts === 1) {
          return jsonResponse({ error: "temporary gateway failure" }, 503);
        }
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      fetchImpl,
      mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
      codaliExecutor: new StubCodaliExecutor(async (input) => successfulCodaliInvocation(input, "retry ok"))
    });

    const result = await runtime.pollAndExecuteJob(1);

    expect(result.executed).toBe(true);
    expect(result.status).toBe("success");
    expect(resultAttempts).toBe(2);
    const posted = postedResult as Record<string, unknown> | null;
    assert.ok(posted);
    expect((posted.openai_response as { choices?: unknown[] } | undefined)?.choices).toHaveLength(1);
  });

  it("posts pre-start relay failures without acknowledging job start", async () => {
    const statePath = tempStatePath();
    let startCalled = false;
    let postedResult: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/poll") {
        return jsonResponse({
          job: {
            job_id: "job-prestart-missing-agent",
            request_id: "req-prestart-missing-agent",
            node_id: "shn_service",
            agent_slug: "mcoda-selected-agent",
            source_agent_slug: "selected-agent",
            provider: "mcoda",
            model: "mcoda-selected-agent",
            openai_request: {
              model: "mcoda-selected-agent",
              messages: [{ role: "user", content: "Run on selected agent." }]
            }
          }
        });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-prestart-missing-agent/start") {
        startCalled = true;
        return jsonResponse({ accepted: true, status: "started" });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-prestart-missing-agent/result") {
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      fetchImpl,
      mcoda: mcodaAgentListClient([
        healthyMcodaAgent({
          slug: "fallback-same-model",
          defaultModel: "mcoda-selected-agent"
        })
      ]),
      codaliExecutor: new StubCodaliExecutor(async (input) => successfulCodaliInvocation(input))
    });

    const result = await runtime.pollAndExecuteJob(1);

    expect(result.executed).toBe(true);
    expect(result.status).toBe("failed");
    expect(startCalled).toBe(false);
    const posted = postedResult as Record<string, unknown> | null;
    assert.ok(posted);
    expect(posted.pre_start_failure).toBe(true);
    expect((posted.error as { code?: string }).code).toBe("selected_agent_unavailable");
  });

  it("fails and degrades when the gateway is missing the start lifecycle endpoint", async () => {
    const statePath = tempStatePath();
    let executorCalled = false;
    let postedResult: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/poll") {
        return jsonResponse({
          job: {
            job_id: "job-missing-start",
            request_id: "req-missing-start",
            node_id: "shn_service",
            agent_slug: "qwen-reviewer",
            source_agent_slug: "qwen-reviewer",
            provider: "mcoda",
            model: "mcoda-qwen-reviewer",
            openai_request: {
              model: "mcoda-qwen-reviewer",
              messages: [{ role: "user", content: "This should not execute." }]
            }
          }
        });
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-missing-start/start") {
        return jsonResponse({ error: "missing route" }, 404);
      }
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-missing-start/result") {
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(permissiveServiceConfigFor(statePath), {
      fetchImpl,
      mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
      codaliExecutor: new StubCodaliExecutor(async (input) => {
        executorCalled = true;
        return successfulCodaliInvocation(input);
      })
    });

    const result = await runtime.pollAndExecuteJob(1);

    expect(result.executed).toBe(true);
    expect(result.status).toBe("failed");
    expect(executorCalled).toBe(false);
    const posted = postedResult as Record<string, unknown> | null;
    assert.ok(posted);
    expect(posted.node_id).toBe("shn_service");
    expect(posted.pre_start_failure).toBe(true);
    expect((posted.error as { code?: string }).code).toBe("self_hosted_protocol_mismatch");
    expect((posted.error as { message?: string }).message || "").toContain(
      "POST /v1/swarm/self-hosted/node/jobs/:jobId/start"
    );
    expect((posted.error as { message?: string }).message || "").toContain("https://gateway.test");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(persisted.lifecycle_health_status).toBe("degraded");
    expect(persisted.lifecycle_health_reason).toBe("self_hosted_protocol_mismatch");

    const nextPoll = await runtime.pollAndExecuteJob(1);
    expect(nextPoll.executed).toBe(false);
    expect(nextPoll.status).toBe("failed");
  });

  it("posts outbound relay stream events while executing streamed jobs", async () => {
    const statePath = tempStatePath();
    const startPosts: Record<string, unknown>[] = [];
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
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/jobs/job-stream-relay/start") {
        startPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ accepted: true, status: "started" });
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
    expect(startPosts).toHaveLength(1);
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

  it("keeps the direct generic job endpoint disabled by default", async () => {
    const statePath = tempStatePath();
    const config = serviceConfigFor(statePath);
    const runtime = new SelfHostedNodeRuntime(config);
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-jobs",
        payload: genericEchoJob()
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.payload).code).toBe("feature_disabled");
    } finally {
      await app.close();
    }
  });

  it("serves owner-local public node capabilities with a capability token", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, {
      nodeId: "shn_public_caps"
    });
    const runtime = new SelfHostedNodeRuntime(config, {
      capabilityRunner: gpuCapabilityProbeRunner()
    });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/swarm/self-hosted/node/capabilities",
        headers: {
          authorization: `Bearer ${signCapabilityToken({
            secret: config.invocationSigningSecret || "",
            nodeId: config.nodeId
          })}`
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as Record<string, unknown>;
      const serialized = JSON.stringify(body);
      const accelerator = (body.accelerators as Record<string, unknown>).gpu as Record<string, unknown>;
      expect(body.generic_jobs_enabled).toBe(true);
      expect((body.job_types as unknown[])).toContain("tenant.test-echo");
      expect((body.job_types as unknown[])).toContain("render.blender");
      expect((body.job_types as unknown[])).toContain("cuda.run");
      expect(accelerator).toMatchObject({
        available: true,
        count: 1,
        cuda: true,
        vram_tier: "16-31"
      });
      expect(serialized).not.toContain("NVIDIA RTX 4090");
      expect(serialized).not.toContain("550.54.14");
      expect(serialized).not.toContain("24564");
    } finally {
      await app.close();
    }
  });

  it("rejects capability reads with generic job tokens", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericEchoJob();
    const runtime = new SelfHostedNodeRuntime(config, {
      capabilityRunner: gpuCapabilityProbeRunner()
    });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/swarm/self-hosted/node/capabilities",
        headers: {
          authorization: `Bearer ${signGenericJobToken({
            secret: config.invocationSigningSecret || "",
            nodeId: job.node_id,
            jobId: job.job_id,
            requestId: job.request_id,
            jobType: job.job.job_type
          })}`
        }
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.payload).code).toBe("unauthorized");
    } finally {
      await app.close();
    }
  });

  it("requires owner-local binding for direct generic jobs", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, { listenHost: "0.0.0.0" });
    const runtime = new SelfHostedNodeRuntime(config);
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-jobs",
        payload: genericEchoJob()
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload).code).toBe("owner_local_required");
    } finally {
      await app.close();
    }
  });

  it("requires a signed generic job token instead of the LLM invocation token scope", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericEchoJob();
    const runtime = new SelfHostedNodeRuntime(config);
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-jobs",
        headers: {
          authorization: `Bearer ${signInvocationToken({
            secret: config.invocationSigningSecret || "",
            nodeId: job.node_id,
            jobId: job.job_id,
            requestId: job.request_id,
            model: "not-a-generic-job"
          })}`,
          "content-type": "application/json"
        },
        payload: job
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.payload).code).toBe("unauthorized");
    } finally {
      await app.close();
    }
  });

  it("rejects generic job tokens that do not match the job schema version", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericEchoJob();
    const runtime = new SelfHostedNodeRuntime(config);
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-jobs",
        headers: {
          authorization: `Bearer ${signGenericJobToken({
            secret: config.invocationSigningSecret || "",
            nodeId: job.node_id,
            jobId: job.job_id,
            requestId: job.request_id,
            schemaVersion: "old-schema",
            jobType: job.job.job_type
          })}`,
          "content-type": "application/json"
        },
        payload: job
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).code).toBe("validation_failed");
    } finally {
      await app.close();
    }
  });

  it("serves direct generic jobs as typed SSE events", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericEchoJob();
    const runtime = new SelfHostedNodeRuntime(config);
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-jobs",
        headers: {
          authorization: `Bearer ${signGenericJobToken({
            secret: config.invocationSigningSecret || "",
            nodeId: job.node_id,
            jobId: job.job_id,
            requestId: job.request_id,
            jobType: job.job.job_type
          })}`,
          accept: "text/event-stream",
          "content-type": "application/json"
        },
        payload: job
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.payload).toContain("event: started");
      expect(response.payload).toContain("event: stdout");
      expect(response.payload).toContain("\"message\":\"hello generic\"");
      expect(response.payload).toContain("event: completed");
      expect(response.payload).toContain("data: [DONE]");
      expect(response.payload).not.toContain("chat.completion.chunk");
    } finally {
      await app.close();
    }
  });

  it("executes direct generic jobs with JSON results when event stream is not requested", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericEchoJob();
    const runtime = new SelfHostedNodeRuntime(config);
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-jobs",
        headers: {
          authorization: `Bearer ${signGenericJobToken({
            secret: config.invocationSigningSecret || "",
            nodeId: job.node_id,
            jobId: job.job_id,
            requestId: job.request_id,
            jobType: job.job.job_type
          })}`,
          "content-type": "application/json"
        },
        payload: job
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as Record<string, unknown>;
      expect(body.status).toBe("succeeded");
      expect((body.result as Record<string, unknown>).status).toBe("succeeded");
      expect((body.events as Array<Record<string, unknown>>).map((event) => event.type)).toEqual([
        "started",
        "stdout",
        "progress",
        "completed"
      ]);
    } finally {
      await app.close();
    }
  });

  it("cancels running direct generic jobs through the owner-local cancel endpoint", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, { genericJobTimeoutMs: 2_000 });
    const baseJob = genericEchoJob();
    const job = genericEchoJob({
      job: {
        ...baseJob.job,
        args: {
          message: "cancel me",
          delay_ms: 50,
          repeat: 10
        },
        limits: {
          timeout_sec: 2
        }
      }
    });
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config);
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const running = app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: job
      });
      await delay(10);
      const cancel = await app.inject({
        method: "POST",
        url: `/v1/swarm/self-hosted/node/generic-jobs/${encodeURIComponent(job.job_id)}/cancel`,
        headers: {
          authorization: `Bearer ${token}`
        }
      });
      const response = await running;

      expect(cancel.statusCode).toBe(202);
      expect(JSON.parse(cancel.payload).status).toBe("cancelling");
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload) as Record<string, unknown>;
      expect(body.status).toBe("cancelled");
      expect(((body.result as Record<string, unknown>).error as Record<string, unknown>).code).toBe("cancelled");

      const secondCancel = await app.inject({
        method: "POST",
        url: `/v1/swarm/self-hosted/node/generic-jobs/${encodeURIComponent(job.job_id)}/cancel`,
        headers: {
          authorization: `Bearer ${token}`
        }
      });
      expect(secondCancel.statusCode).toBe(404);
      expect(JSON.parse(secondCancel.payload).code).toBe("job_not_running");
    } finally {
      await app.close();
    }
  });

  it("requires a matching generic job token for owner-local cancellation", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericEchoJob();
    const runtime = new SelfHostedNodeRuntime(config);
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/swarm/self-hosted/node/generic-jobs/${encodeURIComponent(job.job_id)}/cancel`,
        headers: {
          authorization: `Bearer ${signGenericJobToken({
            secret: config.invocationSigningSecret || "",
            nodeId: job.node_id,
            jobId: "other-job",
            requestId: job.request_id,
            jobType: job.job.job_type
          })}`
        }
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).code).toBe("validation_failed");
    } finally {
      await app.close();
    }
  });

  it("runs owner-local lifecycle jobs and exposes status, events, logs, artifacts, and audit records", async () => {
    const statePath = tempStatePath();
    const baseJob = genericEchoJob();
    const job = genericEchoJob({
      job_id: "job-lifecycle-artifact",
      request_id: "req-lifecycle-artifact",
      job: {
        ...baseJob.job,
        outputs: [
          {
            name: "result",
            path: "out/result.txt",
            content_type: "text/plain",
            required: true
          }
        ]
      }
    });
    const config = genericServiceConfigFor(statePath, {
      artifactStorePath: tempArtifactStorePath(statePath)
    });
    const runner: MswarmGenericJobRunner = {
      id: "test.echo",
      async run(context: MswarmGenericJobRunnerContext) {
        await context.emitEvent({ type: "stdout", message: "artifact ready" });
        mkdirSync(join(context.artifacts.outputDir, "out"), { recursive: true });
        writeFileSync(join(context.artifacts.outputDir, "out", "result.txt"), "phase 5 artifact\n", "utf8");
        return {
          job_id: job.job_id,
          status: "succeeded",
          exit_code: 0,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString()
        };
      }
    };
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config, { genericRunners: [runner], capabilityRunner: capabilityProbeRunner({}) });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: job
      });
      expect(create.statusCode).toBe(202);
      expect(JSON.stringify(JSON.parse(create.payload))).not.toContain(token);

      let statusBody = JSON.parse(create.payload) as Record<string, unknown>;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((statusBody.job as Record<string, unknown>).state === "succeeded") break;
        await delay(10);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}`,
          headers: { authorization: `Bearer ${token}` }
        });
        expect(status.statusCode).toBe(200);
        statusBody = JSON.parse(status.payload) as Record<string, unknown>;
      }

      const lifecycleJob = statusBody.job as Record<string, unknown>;
      expect(lifecycleJob.state).toBe("succeeded");
      expect((lifecycleJob.envelope as Record<string, unknown>).token_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(statusBody)).not.toContain(token);

      const events = await app.inject({
        method: "GET",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/events`,
        headers: { authorization: `Bearer ${token}` }
      });
      const logs = await app.inject({
        method: "GET",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/logs`,
        headers: { authorization: `Bearer ${token}` }
      });
      const artifacts = await app.inject({
        method: "GET",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/artifacts`,
        headers: { authorization: `Bearer ${token}` }
      });
      const audit = await app.inject({
        method: "GET",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/audit`,
        headers: { authorization: `Bearer ${token}` }
      });

      expect(events.statusCode).toBe(200);
      expect((JSON.parse(events.payload).events as Array<Record<string, unknown>>).map((event) => event.type)).toContain("artifact");
      expect(logs.statusCode).toBe(200);
      expect((JSON.parse(logs.payload).logs as Array<Record<string, unknown>>)[0]).toMatchObject({
        stream: "stdout",
        message: "artifact ready"
      });
      expect(artifacts.statusCode).toBe(200);
      const artifactList = JSON.parse(artifacts.payload).artifacts as Array<Record<string, unknown>>;
      expect(artifactList).toHaveLength(1);
      expect(artifactList[0].uri).toMatch(/^artifact:\/\/local\//);
      expect(artifactList[0].size_bytes).toBe(17);
      expect(audit.statusCode).toBe(200);
      expect((JSON.parse(audit.payload).audit as Array<Record<string, unknown>>).map((entry) => entry.action)).toContain(
        "reservation_released"
      );
    } finally {
      await app.close();
    }
  });

  it("accepts owner-local generic lifecycle artifact uploads with safe local artifact URIs", async () => {
    const statePath = tempStatePath();
    const artifactStorePath = tempArtifactStorePath(statePath);
    const config = genericServiceConfigFor(statePath, { artifactStorePath });
    const job = genericCudaJob({
      job_id: "job-upload-cuda-package",
      request_id: "req-upload-cuda-package"
    });
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config, { capabilityRunner: gpuCapabilityProbeRunner() });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const content = Buffer.from("cuda package bytes\n", "utf8");
      const response = await app.inject({
        method: "POST",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/artifacts`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: {
          name: "package",
          path: "inputs/package.tar.gz",
          content_base64: content.toString("base64"),
          content_type: "application/gzip",
          size_bytes: content.length,
          sha256: createHmac("sha256", "not-the-hash").update(content).digest("hex")
        }
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).message).toBe("artifact_upload_checksum_mismatch");

      const ok = await app.inject({
        method: "POST",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/artifacts`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: {
          name: "package",
          path: "inputs/package.tar.gz",
          content_base64: content.toString("base64"),
          content_type: "application/gzip",
          size_bytes: content.length
        }
      });
      expect(ok.statusCode).toBe(201);
      const body = JSON.parse(ok.payload) as Record<string, Record<string, unknown>>;
      expect(body.artifact.uri).toBe("artifact://local/job-upload-cuda-package/inputs/package.tar.gz");
      expect(body.artifact.size_bytes).toBe(content.length);
      expect(body.artifact.content_type).toBe("application/gzip");
      const written = await readFile(join(artifactStorePath, "job-upload-cuda-package", "inputs", "package.tar.gz"), "utf8");
      expect(written).toBe("cuda package bytes\n");

      const unsafe = await app.inject({
        method: "POST",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/artifacts`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: {
          path: "../escape.tar.gz",
          content_base64: content.toString("base64")
        }
      });
      expect(unsafe.statusCode).toBe(400);
      expect(JSON.parse(unsafe.payload).message).toContain("artifact_path_parent_path_not_allowed");
    } finally {
      await app.close();
    }
  });

  it("blocks lifecycle render.blender jobs when Blender is unavailable", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericBlenderJob();
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config, { capabilityRunner: capabilityProbeRunner({}) });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: job
      });
      expect(create.statusCode).toBe(202);

      let statusBody = JSON.parse(create.payload) as Record<string, unknown>;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((statusBody.job as Record<string, unknown>).state === "blocked") break;
        await delay(10);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}`,
          headers: { authorization: `Bearer ${token}` }
        });
        expect(status.statusCode).toBe(200);
        statusBody = JSON.parse(status.payload) as Record<string, unknown>;
      }

      const lifecycleJob = statusBody.job as Record<string, unknown>;
      expect(lifecycleJob.state).toBe("blocked");
      expect(((lifecycleJob.backpressure as Record<string, unknown>).reason as string)).toBe("no_capable_node");
      expect(((lifecycleJob.result as Record<string, unknown>).error as Record<string, unknown>).code).toBe(
        "no_capable_node"
      );
    } finally {
      await app.close();
    }
  });

  it("blocks lifecycle cuda.run jobs when Docker NVIDIA is unavailable", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericCudaJob();
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config, {
      capabilityRunner: async (command, args) => {
        if (command === "nvidia-smi") {
          return { stdout: "0, NVIDIA RTX 4090, 24564, 550.54.14, 8.9\n", stderr: "" };
        }
        if (command === "docker" && args[0] === "info") {
          return { stdout: JSON.stringify({ runc: { path: "runc" } }), stderr: "" };
        }
        if (command === "blender" && args.includes("--version")) {
          return { stdout: "Blender 4.1.1\n", stderr: "" };
        }
        if (command === "ffmpeg") {
          return { stdout: "ffmpeg version 6.1 Copyright\n", stderr: "" };
        }
        throw new Error(`${command} not found`);
      }
    });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: job
      });
      expect(create.statusCode).toBe(202);

      let statusBody = JSON.parse(create.payload) as Record<string, unknown>;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((statusBody.job as Record<string, unknown>).state === "blocked") break;
        await delay(10);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}`,
          headers: { authorization: `Bearer ${token}` }
        });
        expect(status.statusCode).toBe(200);
        statusBody = JSON.parse(status.payload) as Record<string, unknown>;
      }

      const lifecycleJob = statusBody.job as Record<string, unknown>;
      expect(lifecycleJob.state).toBe("blocked");
      expect(((lifecycleJob.backpressure as Record<string, unknown>).reason as string)).toBe("no_capable_node");
      expect(((lifecycleJob.result as Record<string, unknown>).error as Record<string, unknown>).code).toBe(
        "no_capable_node"
      );
    } finally {
      await app.close();
    }
  });

  it("reuses owner-local lifecycle jobs by idempotency key without leaking raw tokens", async () => {
    const statePath = tempStatePath();
    const baseJob = genericEchoJob();
    const job = genericEchoJob({
      job_id: "job-lifecycle-idempotent",
      request_id: "req-lifecycle-idempotent",
      job: {
        ...baseJob.job,
        idempotency_key: "same-logical-job"
      }
    });
    const config = genericServiceConfigFor(statePath);
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config, { capabilityRunner: capabilityProbeRunner({}) });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const first = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: job
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        payload: job
      });

      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(200);
      const body = JSON.parse(second.payload) as Record<string, unknown>;
      expect((body.job as Record<string, unknown>).job_id).toBe(job.job_id);
      expect(JSON.stringify(body)).not.toContain(token);
      expect((body.audit as Array<Record<string, unknown>>).map((entry) => entry.action)).toContain(
        "job_idempotent_reused"
      );
    } finally {
      await app.close();
    }
  });

  it("applies lifecycle tenant backpressure until the active tenant reservation is released", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, {
      genericJobMaxConcurrency: 2,
      genericJobTimeoutMs: 1_000
    });
    const baseJob = genericEchoJob();
    const tenantA = genericEchoJob({
      job_id: "job-lifecycle-tenant-a",
      request_id: "req-lifecycle-tenant-a",
      job: {
        ...baseJob.job,
        args: { message: "tenant a", delay_ms: 50, repeat: 3 },
        limits: { timeout_sec: 1 },
        metadata: { tenant_id: "tenant-a" }
      }
    });
    const tenantB = genericEchoJob({
      job_id: "job-lifecycle-tenant-b",
      request_id: "req-lifecycle-tenant-b",
      job: {
        ...baseJob.job,
        metadata: { tenant_id: "tenant-b" }
      }
    });
    const tokenA = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: tenantA.node_id,
      jobId: tenantA.job_id,
      requestId: tenantA.request_id,
      jobType: tenantA.job.job_type
    });
    const tokenB = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: tenantB.node_id,
      jobId: tenantB.job_id,
      requestId: tenantB.request_id,
      jobType: tenantB.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config, { capabilityRunner: capabilityProbeRunner({}) });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const createA = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        payload: tenantA
      });
      expect(createA.statusCode).toBe(202);
      await delay(15);
      const createB = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" },
        payload: tenantB
      });
      expect(createB.statusCode).toBe(202);
      await delay(15);

      const blockedB = await app.inject({
        method: "GET",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(tenantB.job_id)}`,
        headers: { authorization: `Bearer ${tokenB}` }
      });
      expect(blockedB.statusCode).toBe(200);
      const blockedBody = JSON.parse(blockedB.payload) as Record<string, unknown>;
      expect((blockedBody.job as Record<string, unknown>).state).toBe("queued");
      expect(((blockedBody.job as Record<string, unknown>).backpressure as Record<string, unknown>).reason).toBe(
        "tenant_reserved"
      );

      let finalB = blockedBody;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if ((finalB.job as Record<string, unknown>).state === "succeeded") break;
        await delay(20);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(tenantB.job_id)}`,
          headers: { authorization: `Bearer ${tokenB}` }
        });
        expect(status.statusCode).toBe(200);
        finalB = JSON.parse(status.payload) as Record<string, unknown>;
      }
      expect((finalB.job as Record<string, unknown>).state).toBe("succeeded");
    } finally {
      await app.close();
    }
  });

  it("dispatches lower numeric lifecycle priority before older queued legacy jobs", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, {
      genericJobMaxConcurrency: 1,
      genericJobTimeoutMs: 2_000
    });
    const started: string[] = [];
    const runner: MswarmGenericJobRunner = {
      id: "test.echo",
      async run(context: MswarmGenericJobRunnerContext) {
        started.push(context.job.idempotency_key || "unknown");
        const args = context.job.args || {};
        const delayMs = typeof args.delay_ms === "number" ? args.delay_ms : 0;
        if (delayMs > 0) {
          await delay(delayMs, undefined, { signal: context.signal });
        }
        return {
          job_id: context.job.idempotency_key || "unknown",
          status: "succeeded",
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString()
        };
      }
    };
    const baseJob = genericEchoJob();
    const running = genericEchoJob({
      job_id: "job-priority-running",
      request_id: "req-priority-running",
      job: {
        ...baseJob.job,
        idempotency_key: "running",
        args: { message: "running", delay_ms: 80 }
      }
    });
    const legacy = genericEchoJob({
      job_id: "job-priority-legacy",
      request_id: "req-priority-legacy",
      job: {
        ...baseJob.job,
        idempotency_key: "legacy",
        args: { message: "legacy" }
      }
    });
    const prioritized = genericEchoJob({
      job_id: "job-priority-docdex",
      request_id: "req-priority-docdex",
      job: {
        ...baseJob.job,
        idempotency_key: "docdex",
        args: { message: "docdex" },
        scheduling: { priority: -2, reason_code: "docdex_local_delegation" }
      }
    });
    const tokenFor = (job: SelfHostedGenericNodeJob): string =>
      signGenericJobToken({
        secret: config.invocationSigningSecret || "",
        nodeId: job.node_id,
        jobId: job.job_id,
        requestId: job.request_id,
        jobType: job.job.job_type
      });
    const runtime = new SelfHostedNodeRuntime(config, {
      genericRunners: [runner],
      capabilityRunner: capabilityProbeRunner({})
    });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      for (const job of [running, legacy, prioritized]) {
        const create = await app.inject({
          method: "POST",
          url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
          headers: { authorization: `Bearer ${tokenFor(job)}`, "content-type": "application/json" },
          payload: job
        });
        expect(create.statusCode).toBe(202);
      }

      let priorityBody: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(20);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(prioritized.job_id)}`,
          headers: { authorization: `Bearer ${tokenFor(prioritized)}` }
        });
        expect(status.statusCode).toBe(200);
        priorityBody = JSON.parse(status.payload) as Record<string, unknown>;
        if ((priorityBody.job as Record<string, unknown>).state === "succeeded") break;
      }

      let legacyBody: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(20);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(legacy.job_id)}`,
          headers: { authorization: `Bearer ${tokenFor(legacy)}` }
        });
        expect(status.statusCode).toBe(200);
        legacyBody = JSON.parse(status.payload) as Record<string, unknown>;
        if ((legacyBody.job as Record<string, unknown>).state === "succeeded") break;
      }

      expect(started).toEqual(["running", "docdex", "legacy"]);
      const priorityJob = priorityBody?.job as Record<string, unknown>;
      expect(priorityJob.priority).toBe(-2);
      const legacyJob = legacyBody?.job as Record<string, unknown>;
      expect(legacyJob.priority).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("cancels owner-local lifecycle jobs through the lifecycle cancel endpoint", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, { genericJobTimeoutMs: 2_000 });
    const baseJob = genericEchoJob();
    const job = genericEchoJob({
      job_id: "job-lifecycle-cancel",
      request_id: "req-lifecycle-cancel",
      job: {
        ...baseJob.job,
        args: { message: "cancel lifecycle", delay_ms: 50, repeat: 10 },
        limits: { timeout_sec: 2 }
      }
    });
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config, { capabilityRunner: capabilityProbeRunner({}) });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: job
      });
      expect(create.statusCode).toBe(202);
      await delay(20);
      const cancel = await app.inject({
        method: "POST",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/cancel`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(cancel.statusCode).toBe(202);

      let statusBody = JSON.parse(cancel.payload) as Record<string, unknown>;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((statusBody.job as Record<string, unknown>).state === "cancelled") break;
        await delay(20);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}`,
          headers: { authorization: `Bearer ${token}` }
        });
        expect(status.statusCode).toBe(200);
        statusBody = JSON.parse(status.payload) as Record<string, unknown>;
      }
      const lifecycleJob = statusBody.job as Record<string, unknown>;
      expect(lifecycleJob.state).toBe("cancelled");
      expect(((lifecycleJob.result as Record<string, unknown>).error as Record<string, unknown>).code).toBe("cancelled");
      expect(((lifecycleJob.reservation as Record<string, unknown>).released_at as string).length > 0).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("exposes owner-local lifecycle ops with read-only ops tokens and audit pagination", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, {
      artifactStorePath: tempArtifactStorePath(statePath),
      genericJobMaxConcurrency: 2
    });
    const baseJob = genericEchoJob();
    const job = genericEchoJob({
      job_id: "job-lifecycle-ops",
      request_id: "req-lifecycle-ops",
      job: {
        ...baseJob.job,
        metadata: { tenant_id: "tenant-ops" },
        resources: { gpu: { count: 1 } }
      }
    });
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const opsToken = signGenericJobOpsToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id
    });
    const runtime = new SelfHostedNodeRuntime(config, { capabilityRunner: gpuCapabilityProbeRunner() });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const wrongScope = await app.inject({
        method: "GET",
        url: "/v1/swarm/self-hosted/node/generic-job-control/ops",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(wrongScope.statusCode).toBe(401);

      const create = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: job
      });
      expect(create.statusCode).toBe(202);

      let statusBody = JSON.parse(create.payload) as Record<string, unknown>;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((statusBody.job as Record<string, unknown>).state === "succeeded") break;
        await delay(20);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}`,
          headers: { authorization: `Bearer ${token}` }
        });
        expect(status.statusCode).toBe(200);
        statusBody = JSON.parse(status.payload) as Record<string, unknown>;
      }

      const ops = await app.inject({
        method: "GET",
        url: "/v1/swarm/self-hosted/node/generic-job-control/ops?audit_limit=2&audit_offset=0",
        headers: { authorization: `Bearer ${opsToken}` }
      });
      expect(ops.statusCode).toBe(200);
      const body = JSON.parse(ops.payload) as Record<string, any>;
      expect(body.node.node_id).toBe(config.nodeId);
      expect(body.node.owner_local).toBe(true);
      expect(body.node.artifact_store_configured).toBe(true);
      const opsJob = body.queue.jobs.find((entry: Record<string, unknown>) => entry.job_id === job.job_id);
      expect(Boolean(opsJob)).toBe(true);
      expect(opsJob.priority).toBe(0);
      expect(body.queue.totals_by_state.succeeded).toBe(1);
      expect(body.usage.total_jobs).toBe(1);
      expect(body.usage.succeeded_jobs).toBe(1);
      expect(body.usage.gpu_seconds >= 0).toBe(true);
      expect(body.quota.production_enforced).toBe(false);
      expect(body.audit.limit).toBe(2);
      expect(body.audit.events.length <= 2).toBe(true);
      expect(body.audit.total >= body.audit.events.length).toBe(true);
      expect(JSON.stringify(body)).not.toContain(token);
      expect(JSON.stringify(body)).not.toContain(opsToken);
    } finally {
      await app.close();
    }
  });

  it("requeues terminal non-succeeded lifecycle jobs through the retry endpoint", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath);
    const job = genericBlenderJob({
      job_id: "job-lifecycle-retry",
      request_id: "req-lifecycle-retry"
    });
    const token = signGenericJobToken({
      secret: config.invocationSigningSecret || "",
      nodeId: job.node_id,
      jobId: job.job_id,
      requestId: job.request_id,
      jobType: job.job.job_type
    });
    const runtime = new SelfHostedNodeRuntime(config, { capabilityRunner: capabilityProbeRunner({}) });
    const app = buildSelfHostedNodeApp(runtime, config);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/v1/swarm/self-hosted/node/generic-job-control/jobs",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: job
      });
      expect(create.statusCode).toBe(202);

      let statusBody = JSON.parse(create.payload) as Record<string, unknown>;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((statusBody.job as Record<string, unknown>).state === "blocked") break;
        await delay(10);
        const status = await app.inject({
          method: "GET",
          url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}`,
          headers: { authorization: `Bearer ${token}` }
        });
        expect(status.statusCode).toBe(200);
        statusBody = JSON.parse(status.payload) as Record<string, unknown>;
      }
      expect((statusBody.job as Record<string, unknown>).state).toBe("blocked");

      const retry = await app.inject({
        method: "POST",
        url: `/v1/swarm/self-hosted/node/generic-job-control/jobs/${encodeURIComponent(job.job_id)}/retry`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(retry.statusCode).toBe(202);
      const retryBody = JSON.parse(retry.payload) as Record<string, any>;
      expect(retryBody.job.state).toBe("queued");
      expect(retryBody.job.retry.retry_count).toBe(1);
      expect(retryBody.job.result).toBeUndefined();
      expect((retryBody.audit as Array<Record<string, unknown>>).map((entry) => entry.action)).toContain(
        "job_retry_scheduled"
      );
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
        expect(body.max_concurrent_jobs).toBe(1);
        expect(body.max_concurrent_llm_jobs).toBe(1);
        expect(body.generic_job_max_concurrency).toBe(1);
        expect(body.drain_mode).toBe(false);
        expect(body.load_reporting_enabled).toBe(true);
        expect(body.hardware_telemetry_enabled).toBe(false);
        expect(body.client_allowlist).toEqual([
          { kind: "domain", value: "heka" },
          { kind: "domain", value: "wodo" }
        ]);
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
        expect(body.client_allowlist).toEqual([
          { kind: "domain", value: "heka" },
          { kind: "domain", value: "wodo" }
        ]);
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
        "--clients",
        "heka,wodo",
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
    expect(savedState.max_concurrent_jobs).toBe(1);
    expect(savedState.max_concurrent_llm_jobs).toBe(1);
    expect(savedState.generic_job_max_concurrency).toBe(1);
    expect(savedState.drain_mode).toBe(false);
    expect(savedState.load_reporting_enabled).toBe(true);
    expect(savedState.hardware_telemetry_enabled).toBe(false);
    expect(savedState.client_allowlist).toEqual([
      { kind: "domain", value: "heka" },
      { kind: "domain", value: "wodo" }
    ]);
    expect((await readFile(tempRuntimeTokenPath(statePath), "utf8")).trim()).toBe("msn_setup");
    const daemonConfig = await readSelfHostedNodeConfig({
      MSWARM_SELF_HOSTED_NODE_STATE_PATH: statePath,
      MSWARM_SELF_HOSTED_NODE_KEY_PATH: tempRuntimeTokenPath(statePath)
    } as NodeJS.ProcessEnv);
    expect(daemonConfig.exposeAllModels).toBe(true);
    expect(daemonConfig.jobTimeoutMs).toBe(3_600_000);
    expect(daemonConfig.maxConcurrentJobs).toBe(1);
    expect(daemonConfig.maxConcurrentLlmJobs).toBe(1);
    expect(daemonConfig.genericJobMaxConcurrency).toBe(1);
    expect(daemonConfig.drainMode).toBe(false);
    expect(daemonConfig.loadReportingEnabled).toBe(true);
    expect(daemonConfig.hardwareTelemetryEnabled).toBe(false);
    expect(daemonConfig.modelAllowlist).toEqual(["phi3-reviewer"]);
    expect(daemonConfig.clientAllowlist).toEqual([
      { kind: "domain", value: "heka" },
      { kind: "domain", value: "wodo" }
    ]);
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
        genericJobsEnabled: false,
        genericJobTimeoutMs: 3_600_000,
        genericJobMaxConcurrency: 1,
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: [],
        clientAllowlist: []
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
        genericJobsEnabled: false,
        genericJobTimeoutMs: 3_600_000,
        genericJobMaxConcurrency: 1,
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: [],
        clientAllowlist: []
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
        genericJobsEnabled: false,
        genericJobTimeoutMs: 3_600_000,
        genericJobMaxConcurrency: 1,
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: [],
        clientAllowlist: []
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

  it("reports scheduler-grade runtime load telemetry in heartbeats", async () => {
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
    let markRunnerStarted: () => void = () => {};
    let releaseRunner: () => void = () => {};
    const runnerStarted = new Promise<void>((resolve) => {
      markRunnerStarted = resolve;
    });
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const runner: MswarmGenericJobRunner = {
      id: "test.echo",
      async run() {
        markRunnerStarted();
        await runnerReleased;
        return {
          job_id: "job-load-telemetry",
          status: "succeeded",
          exit_code: 0,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString()
        };
      }
    };
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        runtimeToken: "msn_load",
        maxConcurrentJobs: 4,
        maxConcurrentLlmJobs: 2,
        genericJobMaxConcurrency: 3,
        loadReportingEnabled: true
      }),
      {
        fetchImpl,
        mcoda: mcodaAgentListClient([healthyMcodaAgent({ slug: "phi3-reviewer" })]),
        genericRunners: [runner],
        capabilityRunner: capabilityProbeRunner({})
      }
    );

    const runningJob = runtime.executeGenericJob(genericEchoJob({ job_id: "job-load-telemetry" }));
    await runnerStarted;
    const heartbeat = await runtime.runOnce();
    releaseRunner();
    const genericResult = await runningJob;

    expect(genericResult.status).toBe("succeeded");
    expect(heartbeat.status).toBe("online");
    assert.ok(heartbeat.capacity);
    expect(heartbeat.capacity.active_jobs).toBe(1);
    expect(heartbeat.capacity.free_slots).toBe(3);
    const body = heartbeatBodies[0];
    expect(body.runtime_protocol_version).toBe(1);
    expect(body.runtime as Record<string, unknown>).toMatchObject({
      protocol_version: 1,
      relay_mode: "direct",
      load_reporting_enabled: true,
      hardware_telemetry_enabled: false,
      drain_mode: false
    });
    const capacity = body.capacity as Record<string, unknown>;
    expect(capacity).toMatchObject({
      protocol_version: 1,
      runtime_protocol_version: 1,
      load_balancer_protocol_version: 1,
      catalog_metadata_version: 1,
      max_concurrency: 4,
      max_concurrent_llm_jobs: 2,
      max_concurrent_generic_jobs: 3,
      active_jobs: 1,
      queued_jobs: 0,
      free_slots: 3,
      drain_mode: false
    });
    expect(String(capacity.catalog_fingerprint)).toMatch(/^sha256:[a-f0-9]{64}$/);
    const classCapacity = capacity.execution_class_capacity as Record<string, Record<string, unknown>>;
    expect(classCapacity.agentic).toMatchObject({
      max_concurrency: 2,
      active_jobs: 0,
      queued_jobs: 0,
      free_slots: 2
    });
    expect(classCapacity.generic_job).toMatchObject({
      max_concurrency: 3,
      active_jobs: 1,
      queued_jobs: 0,
      free_slots: 2
    });
    expect(body.local_agent_catalog as Record<string, unknown>).toMatchObject({
      metadata_version: 1,
      model_count: 1,
      exposed_model_count: 1
    });
    expect(String((body.local_agent_catalog as Record<string, unknown>).revision)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(body.hardware_pressure).toBeUndefined();
    const health = body.health as Record<string, unknown>;
    assert.equal(typeof health.avg_latency_ms, "number");
    expect(health.recent_failure_count).toBe(0);
    expect(Array.isArray(health.recent_failures)).toBe(true);
  });

  it("redacts opt-in coarse hardware pressure telemetry", async () => {
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
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        runtimeToken: "msn_hardware_pressure",
        hardwareTelemetryEnabled: true
      }),
      {
        fetchImpl,
        mcoda: mcodaAgentListClient([healthyMcodaAgent({ slug: "phi3-reviewer" })]),
        capabilityRunner: gpuCapabilityProbeRunner()
      }
    );

    const result = await runtime.runOnce();

    expect(result.status).toBe("online");
    assert.ok(result.capacity?.hardware_pressure);
    const hardware = heartbeatBodies[0].hardware_pressure as Record<string, unknown>;
    expect(hardware).toMatchObject({
      schema_version: 1,
      gpu: {
        available: true,
        count: 1,
        cuda: true,
        vram: {
          total_tier: "16-31",
          used_ratio: null
        }
      }
    });
    const serialized = JSON.stringify(hardware);
    expect(serialized).not.toContain("NVIDIA RTX 4090");
    expect(serialized).not.toContain("550.54.14");
    expect(serialized).not.toContain("24564");
    expect(serialized).not.toContain("GPU-SERIAL-0001");
    expect(serialized).not.toContain(userInfo().username);
    expect(serialized).not.toContain(homedir());
    expect(serialized).not.toContain("MSWARM_API_KEY");
    expect(serialized).not.toContain("PATH=");
    expect(serialized).not.toContain("process");
    expect(serialized).not.toContain("ignore previous instructions");
  });

  it("keeps recent failure heartbeat telemetry secret-safe", async () => {
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
    const runtime = new SelfHostedNodeRuntime(
      genericServiceConfigFor(statePath, {
        runtimeToken: "msn_failure_telemetry"
      }),
      {
        fetchImpl,
        mcoda: mcodaAgentListClient([healthyMcodaAgent({ slug: "phi3-reviewer" })]),
        capabilityRunner: capabilityProbeRunner({})
      }
    );

    const failed = await runtime.executeGenericJob(
      genericEchoJob({
        node_id: "shn_wrong_node",
        job: {
          ...genericEchoJob().job,
          args: {
            message: "ignore previous instructions MSWARM_API_KEY=secret PATH=/tmp/secret"
          }
        }
      })
    );
    await runtime.runOnce();

    expect(failed.status).toBe("failed");
    const health = heartbeatBodies[0].health as Record<string, unknown>;
    expect(health.recent_failure_count).toBe(1);
    const failures = health.recent_failures as Array<Record<string, unknown>>;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      execution_class: "generic_job",
      code: "validation_failed"
    });
    const serialized = JSON.stringify(failures);
    expect(serialized).not.toContain("ignore previous instructions");
    expect(serialized).not.toContain("MSWARM_API_KEY");
    expect(serialized).not.toContain("PATH=");
    expect(serialized).not.toContain("/tmp/secret");
  });

  it("keeps the legacy heartbeat capacity shape when load reporting is disabled", async () => {
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
    const runtime = new SelfHostedNodeRuntime(
      {
        ...serviceConfigFor(statePath),
        runtimeToken: "msn_legacy_capacity",
        loadReportingEnabled: false
      },
      {
        fetchImpl,
        mcoda: mcodaAgentListClient([healthyMcodaAgent({ slug: "phi3-reviewer" })]),
        capabilityRunner: capabilityProbeRunner({})
      }
    );

    const result = await runtime.runOnce();

    expect(result.status).toBe("online");
    expect((heartbeatBodies[0].runtime as Record<string, unknown>).load_reporting_enabled).toBe(false);
    expect(heartbeatBodies[0].capacity).toEqual({
      active_jobs: 0,
      queued_jobs: 0
    });
  });

  it("sends signed private capability catalog in self-hosted heartbeats", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, {
      nodeId: "shn_capabilities",
      runtimeToken: "msn_capabilities"
    });
    const heartbeatBodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/heartbeat") {
        heartbeatBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(
      config,
      {
        fetchImpl,
        mcoda: mcodaAgentListClient([healthyMcodaAgent({ slug: "qwen-reviewer" })]),
        capabilityRunner: gpuCapabilityProbeRunner()
      }
    );

    const result = await runtime.runOnce();

    expect(result.status).toBe("online");
    const body = heartbeatBodies[0];
    const capabilities = body.capabilities as Record<string, unknown>;
    const privateCatalog = capabilities.private_catalog_entry as Record<string, unknown>;
    const snapshot = (privateCatalog.snapshot as Record<string, unknown>);
    const gpu = snapshot.gpu as Record<string, unknown>;
    const devices = gpu.devices as Array<Record<string, unknown>>;
    const publicProjection = capabilities.public_projection as Record<string, unknown>;
    const publicSerialized = JSON.stringify(publicProjection);
    expect(devices[0].name).toBe("NVIDIA RTX 4090");
    expect(publicSerialized).not.toContain("NVIDIA RTX 4090");
    expect(publicSerialized).not.toContain("550.54.14");
    expect(publicSerialized).not.toContain("24564");
    expect(((capabilities.scheduler_match as Record<string, unknown>).resources as Record<string, unknown>)).toMatchObject({
      gpu_count: 1,
      has_cuda: true
    });
    const unsigned = {
      schema_version: capabilities.schema_version,
      snapshot_id: capabilities.snapshot_id,
      private_catalog_entry: capabilities.private_catalog_entry,
      scheduler_match: capabilities.scheduler_match,
      public_projection: capabilities.public_projection
    };
    const expectedSignature = base64Url(
      createHmac("sha256", config.runtimeToken || "").update(JSON.stringify(unsigned)).digest()
    );
    expect((capabilities.signature as Record<string, unknown>).value).toBe(expectedSignature);
  });

  it("keeps capability heartbeat payloads degraded-safe when probes fail", async () => {
    const statePath = tempStatePath();
    const config = genericServiceConfigFor(statePath, {
      nodeId: "shn_capability_degraded",
      runtimeToken: "msn_capability_degraded"
    });
    const heartbeatBodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://gateway.test/v1/swarm/self-hosted/node/heartbeat") {
        heartbeatBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ accepted: true });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    const runtime = new SelfHostedNodeRuntime(
      config,
      {
        fetchImpl,
        mcoda: mcodaAgentListClient([healthyMcodaAgent()]),
        capabilityRunner: capabilityProbeRunner({})
      }
    );

    await runtime.runOnce();

    const capabilities = heartbeatBodies[0].capabilities as Record<string, unknown>;
    const privateCatalog = capabilities.private_catalog_entry as Record<string, unknown>;
    const snapshot = privateCatalog.snapshot as Record<string, unknown>;
    const gpu = snapshot.gpu as Record<string, unknown>;
    const publicProjection = capabilities.public_projection as Record<string, unknown>;
    const accelerators = (publicProjection.accelerators as Record<string, unknown>).gpu as Record<string, unknown>;
    expect(gpu.status).toBe("missing");
    expect(accelerators.available).toBe(false);
    expect((snapshot.job_types as unknown[])).not.toContain("render.blender");
    expect((snapshot.job_types as unknown[])).not.toContain("cuda.run");
    expect((snapshot.diagnostics as unknown[]).length > 0).toBe(true);
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
        genericJobsEnabled: false,
        genericJobTimeoutMs: 3_600_000,
        genericJobMaxConcurrency: 1,
        exposeAllModels: true,
        modelAllowlist: [],
        modelBlocklist: [],
        clientAllowlist: []
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
