import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cwd = path.resolve(__dirname, "..");

const normalizePath = (value) => value.replace(/\\/g, "/");

const bannedMatchers = [
  { pattern: /(^|\/)node_modules\//, reason: "node_modules" },
  { pattern: /(^|\/)\.mcoda(\/|$)/, reason: "mcoda workspace state" },
  { pattern: /(^|\/)\.docdex(\/|$)/, reason: "docdex state" },
  { pattern: /(^|\/)dist\/__tests__\//, reason: "compiled tests" },
  { pattern: /\.test\.[cm]?js$/i, reason: "test artifacts" },
];

const requiredPaths = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "dist/bin/McodaEntrypoint.js",
];

const getPackList = () => {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`npm pack --dry-run --json did not return JSON: ${err.message}\n${stdout}`);
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries
    .flatMap((entry) => (entry.files || []).map((file) => (typeof file === "string" ? file : file.path)))
    .filter(Boolean)
    .map(normalizePath);
};

test("npm tarball has expected files and excludes unwanted artifacts", () => {
  const files = getPackList();
  const offenders = [];

  for (const file of files) {
    for (const { pattern, reason } of bannedMatchers) {
      if (pattern.test(file)) {
        offenders.push(`${file} (${reason})`);
        break;
      }
    }
  }

  const missing = requiredPaths.filter((req) => !files.includes(req));

  assert.equal(
    offenders.length,
    0,
    `Packaging guardrails violated. Remove unexpected files:\n${offenders.join("\n")}`,
  );
  assert.equal(
    missing.length,
    0,
    `Packaging guardrails violated. Required files missing:\n${missing.join("\n")}`,
  );
});
