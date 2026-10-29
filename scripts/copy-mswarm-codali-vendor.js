#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "codali", "dist");
const destination = path.join(root, "packages", "mswarm", "dist", "vendor", "codali");
const skills = path.join(root, "packages", "codali", "config", "skills");
const vendoredSkills = path.resolve(destination, "../config/skills");

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

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
copyDirectory(source, destination);
// SkillCatalog resolves ../../config/skills from the runtime's session module.
rmSync(vendoredSkills, { recursive: true, force: true });
if (existsSync(skills)) copyDirectory(skills, vendoredSkills);

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
