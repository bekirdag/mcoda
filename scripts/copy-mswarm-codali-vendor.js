#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "codali", "dist");
const destination = path.join(root, "packages", "mswarm", "dist", "vendor", "codali");
const config = path.join(root, "packages", "codali", "config");
const vendoredConfig = path.resolve(destination, "../config");
const runtimeAssets = ["AGENTS.md", "docdex-runtime.json", "docdex-tools-0.2.99.json", "skills", "deterministic", "documents"];

// The copied runtime resolves dependencies from @mcoda/mswarm, not from the
// source Codali package. Refuse an incomplete runtime before replacing output.
const codali = JSON.parse(readFileSync(path.join(root, "packages", "codali", "package.json"), "utf8"));
const mswarm = JSON.parse(readFileSync(path.join(root, "packages", "mswarm", "package.json"), "utf8"));
for (const [name, version] of Object.entries(codali.dependencies ?? {})) {
  if (mswarm.dependencies?.[name] !== version) {
    throw new Error(`Vendored Codali requires @mcoda/mswarm dependency ${name}@${version}; keep runtime dependency declarations aligned.`);
  }
}

if (!existsSync(source)) {
  throw new Error("packages/codali/dist is missing; build @mcoda/codali before packaging mswarm.");
}
for (const entry of runtimeAssets) {
  if (!existsSync(path.join(config, entry))) throw new Error(`Vendored Codali runtime asset is missing: config/${entry}`);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
copyDirectory(source, destination);
// Runtime modules resolve config relative to the copied dist tree. Copy only
// declared package assets, including Docdex catalogs and offline installers.
rmSync(vendoredConfig, { recursive: true, force: true });
mkdirSync(vendoredConfig, { recursive: true });
for (const entry of runtimeAssets) {
  const from = path.join(config, entry), to = path.join(vendoredConfig, entry);
  if (statSync(from).isDirectory()) copyDirectory(from, to);
  else copyFileSync(from, to);
}

function copyDirectory(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (shouldSkip(entry)) {
      continue;
    }
    const sourcePath = path.join(from, entry);
    const destinationPath = path.join(to, entry);
    const info = statSync(sourcePath);
    if (info.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (info.isFile()) {
      copyFileSync(sourcePath, destinationPath);
    }
  }
}

function shouldSkip(name) {
  return (
    name.startsWith(".") || name === "__tests__" || name === "__pycache__" || /\.pyc$/i.test(name) ||
    /\.test\.(?:[cm]?js|d\.ts)(?:\.map)?$/i.test(name)
  );
}
