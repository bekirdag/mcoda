import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  collectWorkspacePackages,
  orderWorkspacePackages,
  parseInstallArgs,
} from "../../scripts/install-local-packages.js";

test("parseInstallArgs enables binsOnly only when requested", () => {
  assert.deepEqual(parseInstallArgs([]), { binsOnly: false, dryRun: false });
  assert.deepEqual(parseInstallArgs(["--bins-only"]), { binsOnly: true, dryRun: false });
  assert.deepEqual(parseInstallArgs(["--dry-run"]), { binsOnly: false, dryRun: true });
});

test("collectWorkspacePackages skips private packages and captures workspace metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-install-local-"));
  try {
    await fs.mkdir(path.join(root, "packages", "shared"), { recursive: true });
    await fs.mkdir(path.join(root, "packages", "cli"), { recursive: true });
    await fs.mkdir(path.join(root, "packages", "private"), { recursive: true });

    await fs.writeFile(
      path.join(root, "packages", "shared", "package.json"),
      JSON.stringify({ name: "@mcoda/shared", version: "0.0.0" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "packages", "cli", "package.json"),
      JSON.stringify({
        name: "mcoda",
        version: "0.0.0",
        bin: { mcoda: "dist/bin.js" },
        dependencies: {
          "@mcoda/shared": "workspace:*",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "packages", "private", "package.json"),
      JSON.stringify({ name: "private-pkg", version: "0.0.0", private: true }),
      "utf8",
    );

    const packages = collectWorkspacePackages(root);
    assert.equal(packages.length, 2);
    assert.deepEqual(
      packages.map((pkg) => ({
        name: pkg.name,
        hasBin: pkg.hasBin,
        localDependencyNames: pkg.localDependencyNames,
      })),
      [
        { name: "mcoda", hasBin: true, localDependencyNames: ["@mcoda/shared"] },
        { name: "@mcoda/shared", hasBin: false, localDependencyNames: [] },
      ],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("orderWorkspacePackages sorts local dependencies before dependents", () => {
  const ordered = orderWorkspacePackages([
    {
      name: "mcoda",
      relDir: "packages/cli",
      dir: "/repo/packages/cli",
      hasBin: true,
      localDependencyNames: ["@mcoda/core", "@mcoda/shared"],
    },
    {
      name: "@mcoda/core",
      relDir: "packages/core",
      dir: "/repo/packages/core",
      hasBin: false,
      localDependencyNames: ["@mcoda/shared", "@mcoda/db"],
    },
    {
      name: "@mcoda/shared",
      relDir: "packages/shared",
      dir: "/repo/packages/shared",
      hasBin: false,
      localDependencyNames: [],
    },
    {
      name: "@mcoda/db",
      relDir: "packages/db",
      dir: "/repo/packages/db",
      hasBin: false,
      localDependencyNames: ["@mcoda/shared"],
    },
  ]);

  assert.deepEqual(ordered.map((pkg) => pkg.name), [
    "@mcoda/shared",
    "@mcoda/db",
    "@mcoda/core",
    "mcoda",
  ]);
});
