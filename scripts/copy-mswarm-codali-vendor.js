#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "codali", "dist");
const destination = path.join(root, "packages", "mswarm", "dist", "vendor", "codali");

if (!existsSync(source)) {
  throw new Error("packages/codali/dist is missing; build @mcoda/codali before packaging mswarm.");
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
copyDirectory(source, destination);

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
    name === "__tests__" ||
    /\.test\.(?:[cm]?js|d\.ts)(?:\.map)?$/i.test(name)
  );
}
