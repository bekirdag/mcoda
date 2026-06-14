import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MSWARM_CAPABILITY_SCHEMA_VERSION,
  buildMswarmCapabilityNames,
  buildMswarmPrivateCapabilityCatalogEntry,
  buildMswarmSchedulerMatchInput,
  projectMswarmPublicCapabilities,
  type MswarmNodeCapabilitySnapshot,
} from "../mswarm/CapabilityContract.js";

function capabilitySnapshot(): MswarmNodeCapabilitySnapshot {
  return {
    schema_version: MSWARM_CAPABILITY_SCHEMA_VERSION,
    snapshot_id: "caps_test",
    captured_at: "2026-06-14T00:00:00.000Z",
    node_id: "shn_private",
    platform: "linux",
    arch: "x64",
    generic_jobs_enabled: true,
    job_types: ["tenant.test-echo"],
    trust_modes: ["owner-local"],
    gpu: {
      status: "available",
      count: 1,
      vendors: ["nvidia"],
      max_vram_gb: 24,
      cuda_versions: ["12.4"],
      devices: [
        {
          id: "gpu-0",
          vendor: "nvidia",
          name: "NVIDIA RTX 4090",
          vram_gb: 24,
          driver_version: "550.54.14",
          cuda_version: "12.4",
          compute_capability: "8.9",
          capabilities: ["cuda"],
        },
      ],
    },
    software: {
      docker: { name: "docker", status: "available", version: "26.1.0" },
      "docker-nvidia": { name: "docker-nvidia", status: "available", version: "nvidia" },
      blender: { name: "blender", status: "available", version: "4.1.1" },
      ffmpeg: { name: "ffmpeg", status: "available", version: "6.1" },
    },
    runner_catalog: [
      {
        job_type: "tenant.test-echo",
        runner: "test.echo",
        trust_modes: ["owner-local"],
        required_capabilities: [],
      },
    ],
  };
}

describe("MswarmCapabilityContract", () => {
  it("builds scheduler input with private match details and capability names", () => {
    const snapshot = capabilitySnapshot();
    const scheduler = buildMswarmSchedulerMatchInput(snapshot);

    assert.equal(scheduler.schema_version, MSWARM_CAPABILITY_SCHEMA_VERSION);
    assert.equal(scheduler.snapshot_id, "caps_test");
    assert.equal(scheduler.node_id, "shn_private");
    assert.equal(scheduler.resources.gpu_count, 1);
    assert.deepEqual(scheduler.resources.gpu_vendors, ["nvidia"]);
    assert.equal(scheduler.resources.max_vram_gb, 24);
    assert.equal(scheduler.resources.has_cuda, true);
    assert.equal(scheduler.resources.software.docker_nvidia, true);
    assert.equal(scheduler.resources.software.blender, true);
    assert.equal(scheduler.resources.software.ffmpeg, true);
    assert.deepEqual(scheduler.available_job_types, ["tenant.test-echo"]);
    assert.ok(scheduler.capabilities.includes("gpu.nvidia"));
    assert.ok(scheduler.capabilities.includes("cuda"));
    assert.ok(scheduler.capabilities.includes("software.blender"));
    assert.ok(scheduler.capabilities.includes("job_type:tenant.test-echo"));
  });

  it("projects public capabilities without raw node hardware inventory", () => {
    const snapshot = capabilitySnapshot();
    const projection = projectMswarmPublicCapabilities(snapshot);
    const serialized = JSON.stringify(projection);

    assert.equal(projection.accelerators.gpu.available, true);
    assert.equal(projection.accelerators.gpu.count, 1);
    assert.deepEqual(projection.accelerators.gpu.vendors, ["nvidia"]);
    assert.equal(projection.accelerators.gpu.cuda, true);
    assert.equal(projection.accelerators.gpu.vram_tier, "16-31");
    assert.equal(projection.software.blender.available, true);
    assert.equal(projection.software.ffmpeg.available, true);
    assert.ok(!serialized.includes("NVIDIA RTX 4090"));
    assert.ok(!serialized.includes("550.54.14"));
    assert.ok(!serialized.includes("12.4"));
    assert.ok(!serialized.includes("24"));
  });

  it("keeps private catalog details separate from public projection", () => {
    const snapshot = capabilitySnapshot();
    const catalogEntry = buildMswarmPrivateCapabilityCatalogEntry(snapshot);

    assert.equal(catalogEntry.snapshot.gpu.devices[0]?.name, "NVIDIA RTX 4090");
    assert.equal(catalogEntry.scheduler_match.resources.max_vram_gb, 24);
    assert.equal(catalogEntry.public_projection.accelerators.gpu.vram_tier, "16-31");
    assert.ok(!JSON.stringify(catalogEntry.public_projection).includes("RTX 4090"));
  });

  it("omits unavailable software and GPUs from derived capability names", () => {
    const snapshot: MswarmNodeCapabilitySnapshot = {
      ...capabilitySnapshot(),
      gpu: {
        status: "missing",
        count: 0,
        vendors: [],
        devices: [],
        message: "nvidia-smi not found",
      },
      software: {
        docker: { name: "docker", status: "missing" },
        "docker-nvidia": { name: "docker-nvidia", status: "missing" },
        blender: { name: "blender", status: "missing" },
        ffmpeg: { name: "ffmpeg", status: "available", version: "6.1" },
      },
    };

    assert.deepEqual(buildMswarmCapabilityNames(snapshot), [
      "generic_jobs",
      "job_type:tenant.test-echo",
      "software.ffmpeg",
    ]);
  });
});
