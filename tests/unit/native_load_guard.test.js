import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureMediaBridgeEnvironment } from "../helpers/media-bridge-environment.js";

const here = path.dirname(fileURLToPath(import.meta.url));
configureMediaBridgeEnvironment(test, path.resolve(here, "../../packages/mswarm/scripts"));
const available = process.platform === "linux" && spawnSync("python3", ["-c", "import fcntl"], { stdio: "ignore" }).status === 0;

test("native model load admission preserves media leases, host RAM and original peer ownership", { skip: !available }, () => {
  const result = spawnSync("python3", [path.join(here, "native_load_guard_cases.py")], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /OK/);
});
