import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MSWARM_GENERIC_JOB_SCHEMA_VERSION,
  MSWARM_KNOWN_JOB_ARG_KEYS,
  MSWARM_JOB_EVENT_TYPES,
  MSWARM_JOB_STATUSES,
  isMswarmGenericJobRequest,
  validateMswarmGenericJobRequest,
} from "../mswarm/GenericJobContract.js";

const validRenderJob = () => ({
  schema_version: MSWARM_GENERIC_JOB_SCHEMA_VERSION,
  job_type: "render.blender",
  inputs: [
    {
      name: "scene",
      artifact: {
        uri: "artifact://scene.blend",
        content_type: "application/octet-stream",
        sha256: "abc123",
      },
      mount_path: "input/scene.blend",
      required: true,
    },
  ],
  args: {
    frames: "1-10",
    engine: "cycles",
    resolution: "1920x1080",
  },
  resources: {
    gpu: {
      count: 1,
      min_vram_gb: 8,
      vendor: "nvidia",
      cuda_min_version: "12.0",
    },
    cpu: {
      cores: 4,
    },
    memory_gb: 16,
    disk_gb: 32,
  },
  limits: {
    timeout_sec: 600,
    max_stdout_bytes: 1024,
  },
  outputs: [
    {
      name: "frames",
      path: "out/frames",
      content_type: "image/png",
    },
  ],
  policy: {
    trust_mode: "tenant-owned",
    network: "none",
    allow_raw_command: false,
    allowed_images: ["nvidia/cuda:12.4.1-devel-ubuntu22.04"],
    max_artifact_bytes: 1024,
  },
  metadata: {
    request: "phase-1-test",
  },
});

describe("MswarmGenericJobContract", () => {
  it("accepts a versioned known generic job without LLM or worker fields", () => {
    const result = validateMswarmGenericJobRequest(validRenderJob());

    assert.equal(result.ok, true);
    assert.equal(isMswarmGenericJobRequest(validRenderJob()), true);
    assert.equal(result.value?.schema_version, MSWARM_GENERIC_JOB_SCHEMA_VERSION);
    assert.equal(result.value?.job_type, "render.blender");
    assert.equal(result.value?.policy.network, "none");
    assert.equal(result.value?.inputs?.[0]?.artifact.uri, "artifact://scene.blend");
  });

  it("defaults policy.network to none but still requires serialized policy", () => {
    const job = validRenderJob();
    delete (job.policy as { network?: string }).network;
    const result = validateMswarmGenericJobRequest(job);

    assert.equal(result.ok, true);
    assert.equal(result.value?.policy.network, "none");

    const missingPolicy = validRenderJob();
    delete (missingPolicy as { policy?: unknown }).policy;
    const rejected = validateMswarmGenericJobRequest(missingPolicy);

    assert.equal(rejected.ok, false);
    assert.ok(rejected.issues.some((issue) => issue.code === "invalid_policy" && issue.path === "policy"));
  });

  it("rejects unsupported schema versions and unregistered tenant job types", () => {
    const badVersion = {
      ...validRenderJob(),
      schema_version: "2027-01-01",
    };
    const badVersionResult = validateMswarmGenericJobRequest(badVersion);

    assert.equal(badVersionResult.ok, false);
    assert.ok(badVersionResult.issues.some((issue) => issue.code === "invalid_schema_version"));

    const tenantJob = {
      ...validRenderJob(),
      job_type: "tenant.video-render",
      args: {
        profile: "default",
      },
    };
    const unregistered = validateMswarmGenericJobRequest(tenantJob);

    assert.equal(unregistered.ok, false);
    assert.ok(unregistered.issues.some((issue) => issue.code === "unregistered_job_type"));

    const nameOnlyRegistration = validateMswarmGenericJobRequest(tenantJob, {
      registeredJobTypes: ["tenant.video-render"],
    });

    assert.equal(nameOnlyRegistration.ok, false);
    assert.ok(nameOnlyRegistration.issues.some((issue) => issue.code === "invalid_registered_job_catalog"));

    const registered = validateMswarmGenericJobRequest(tenantJob, {
      registeredJobCatalog: [
        {
          job_type: "tenant.video-render",
          args_schema: {
            type: "object",
            additionalProperties: true,
          },
          policy: {
            trust_mode: "tenant-owned",
            network: "none",
            allow_raw_command: false,
          },
          runner: "tenant-video-render-runner",
        },
      ],
    });

    assert.equal(registered.ok, true);
    assert.equal(registered.value?.job_type, "tenant.video-render");
  });

  it("dispatches known job-type arg validation instead of sharing one permissive schema", () => {
    const cudaJob = {
      ...validRenderJob(),
      job_type: "cuda.run",
      args: {
        manifest_path: "jobs/manifest.json",
        profile: "smoke",
        target: "vector-add",
      },
    };
    const cudaResult = validateMswarmGenericJobRequest(cudaJob);

    assert.equal(cudaResult.ok, true);
    assert.ok(MSWARM_KNOWN_JOB_ARG_KEYS["cuda.run"].includes("manifest_path"));

    const crossTypeArgs = validateMswarmGenericJobRequest({
      ...validRenderJob(),
      job_type: "cuda.run",
      args: {
        frames: "1-10",
      },
    });

    assert.equal(crossTypeArgs.ok, false);
    assert.ok(crossTypeArgs.issues.some((issue) => issue.code === "unknown_field" && issue.path === "args.frames"));

    const unsafeCudaArgs = validateMswarmGenericJobRequest({
      ...validRenderJob(),
      job_type: "cuda.run",
      args: {
        manifest_path: "../mcoda-job.json",
        profile: "nvcc default",
        target: "",
      },
    });

    assert.equal(unsafeCudaArgs.ok, false);
    assert.ok(unsafeCudaArgs.issues.some((issue) => issue.code === "unsafe_path" && issue.path === "args.manifest_path"));
    assert.ok(unsafeCudaArgs.issues.some((issue) => issue.code === "invalid_args" && issue.path === "args.profile"));
    assert.ok(unsafeCudaArgs.issues.some((issue) => issue.code === "invalid_args" && issue.path === "args.target"));
  });

  it("rejects unsafe runtime controls in top-level fields, args, limits, and metadata", () => {
    const result = validateMswarmGenericJobRequest({
      ...validRenderJob(),
      runtime: "docker-nvidia",
      args: {
        command: ["bash", "-lc", "nvidia-smi"],
        image: "nvidia/cuda:latest",
        frames: "1",
      },
      limits: {
        network: "egress-allowlist",
      },
      metadata: {
        network: "egress-allowlist",
        team: "rendering",
      },
    });

    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "unknown_field" && issue.path === "runtime"));
    assert.ok(result.issues.some((issue) => issue.code === "unsafe_field" && issue.path === "args.command"));
    assert.ok(result.issues.some((issue) => issue.code === "unsafe_field" && issue.path === "args.image"));
    assert.ok(result.issues.some((issue) => issue.code === "unsafe_field" && issue.path === "limits.network"));
    assert.ok(result.issues.some((issue) => issue.code === "unsafe_field" && issue.path === "metadata.network"));
  });

  it("rejects internal runner substrate names as public job types", () => {
    const result = validateMswarmGenericJobRequest({
      ...validRenderJob(),
      job_type: "docker-nvidia",
    });

    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "invalid_job_type"));
  });

  it("rejects LLM and mswarm-worker adapter fields instead of treating them as generic jobs", () => {
    const llmJob = {
      job_id: "job-1",
      request_id: "req-1",
      node_id: "node-1",
      agent_slug: "coder",
      adapter: "mswarm-worker",
      model: "gpt-5",
      openai_request: {
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
      },
      schema_version: MSWARM_GENERIC_JOB_SCHEMA_VERSION,
      job_type: "render.blender",
      policy: {
        trust_mode: "tenant-owned",
      },
    };

    const result = validateMswarmGenericJobRequest(llmJob);

    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "llm_field_not_allowed" && issue.path === "openai_request"));
    assert.ok(result.issues.some((issue) => issue.code === "llm_field_not_allowed" && issue.path === "adapter"));
    assert.equal(isMswarmGenericJobRequest(llmJob), false);
  });

  it("rejects raw artifact URLs and sandbox-escaping paths by default", () => {
    const result = validateMswarmGenericJobRequest({
      ...validRenderJob(),
      inputs: [
        {
          name: "scene",
          artifact: {
            uri: "https://example.com/scene.blend",
          },
          mount_path: "../scene.blend",
        },
      ],
      outputs: [
        {
          name: "frames",
          path: "/tmp/frames",
        },
      ],
    });

    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "unsafe_artifact_uri"));
    assert.ok(result.issues.some((issue) => issue.code === "unsafe_path" && issue.path === "inputs.0.mount_path"));
    assert.ok(result.issues.some((issue) => issue.code === "unsafe_path" && issue.path === "outputs.0.path"));
  });

  it("exposes status and event taxonomies for job lifecycle contracts", () => {
    assert.ok(MSWARM_JOB_STATUSES.includes("queued"));
    assert.ok(MSWARM_JOB_STATUSES.includes("succeeded"));
    assert.ok(MSWARM_JOB_EVENT_TYPES.includes("scheduled"));
    assert.ok(MSWARM_JOB_EVENT_TYPES.includes("log_truncated"));
  });
});
