import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMswarmLocalArtifactUri,
  buildMswarmSandboxProfile,
  defaultMswarmArtifactAccessPolicy,
  defaultMswarmArtifactRetentionPolicy,
  normalizeMswarmSafeRelativePath,
  validateMswarmArchiveEntry,
  validateMswarmOutputSpecPath,
} from "../mswarm/ArtifactSandboxContract.js";

describe("MswarmArtifactSandboxContract", () => {
  it("normalizes safe relative artifact and output paths", () => {
    assert.deepEqual(normalizeMswarmSafeRelativePath("./frames/0001.png"), {
      ok: true,
      normalized: "frames/0001.png",
    });
    assert.deepEqual(validateMswarmOutputSpecPath({ name: "frames", path: "out/render.png" }), {
      ok: true,
      normalized: "out/render.png",
    });
  });

  it("rejects path traversal, absolute paths, URLs, Windows separators, and null bytes", () => {
    const rejected = [
      "../secret",
      "/etc/passwd",
      "C:/Users/owner/file",
      "http://example.test/file",
      "out\\file.png",
      "out/\0file.png",
    ];

    for (const path of rejected) {
      assert.equal(normalizeMswarmSafeRelativePath(path).ok, false, path);
    }
  });

  it("hardens archive extraction against links and unsafe entries", () => {
    assert.equal(validateMswarmArchiveEntry({ path: "scene/scene.blend", type: "file" }).ok, true);
    assert.equal(validateMswarmArchiveEntry({ path: "scene", type: "directory" }).ok, true);
    assert.equal(validateMswarmArchiveEntry({ path: "../escape", type: "file" }).ok, false);
    assert.equal(validateMswarmArchiveEntry({ path: "scene/link", type: "symlink" }).reason, "archive_symlink_not_allowed");
    assert.equal(validateMswarmArchiveEntry({ path: "scene/link", type: "hardlink" }).reason, "archive_hardlink_not_allowed");
    assert.equal(validateMswarmArchiveEntry({ path: "scene/device", type: "device" }).reason, "archive_device_not_allowed");
  });

  it("builds local artifact URIs without exposing host paths", () => {
    assert.equal(
      buildMswarmLocalArtifactUri("job:render/1", "frames/0001.png"),
      "artifact://local/job_render_1/frames/0001.png"
    );
  });

  it("defaults artifact access and retention policy for owner-local development", () => {
    assert.deepEqual(defaultMswarmArtifactAccessPolicy(), {
      visibility: "owner-local",
      read_by: ["runner", "owner"],
      write_by: ["runner", "owner"],
    });
    assert.deepEqual(defaultMswarmArtifactRetentionPolicy(60), {
      retain_for_seconds: 60,
    });
  });

  it("uses non-root container sandbox defaults when containerized", () => {
    const profile = buildMswarmSandboxProfile({
      policy: {
        trust_mode: "tenant-owned",
        network: "none",
        allow_raw_command: false,
        allowed_images: ["nvidia/cuda:12.4.1-devel-ubuntu22.04"],
      },
      limits: {
        timeout_sec: 600,
        max_output_bytes: 1024,
      },
      containerized: true,
      gpu: "nvidia",
    });

    assert.equal(profile.name, "container-nvidia");
    assert.equal(profile.network, "none");
    assert.equal(profile.allow_raw_command, false);
    assert.equal(profile.filesystem.working_directory, "per-job");
    assert.equal(profile.filesystem.allow_host_paths, false);
    assert.equal(profile.container.enabled, true);
    assert.equal(profile.container.rootless, true);
    assert.equal(profile.container.user, "65532:65532");
    assert.equal(profile.container.privileged, false);
    assert.equal(profile.container.read_only_root_fs, true);
    assert.deepEqual(profile.container.allowed_images, ["nvidia/cuda:12.4.1-devel-ubuntu22.04"]);
  });
});
