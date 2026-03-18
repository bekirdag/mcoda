#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const distBootstrapPath = path.join(
  packageRoot,
  "dist",
  "install",
  "MswarmConsentBootstrap.js"
);

const isInstallLocal = process.argv.includes("--install-local");

const shouldSkipWorkspacePostinstall = () => {
  if (isInstallLocal) {
    return false;
  }
  const repoRoot = path.resolve(packageRoot, "..", "..");
  return existsSync(path.join(repoRoot, "pnpm-workspace.yaml"));
};

const shouldSkip = () =>
  process.env.MCODA_SKIP_POSTINSTALL_CONSENT === "1" ||
  shouldSkipWorkspacePostinstall() ||
  !existsSync(distBootstrapPath);

const main = async () => {
  if (shouldSkip()) {
    return;
  }
  const moduleHref = pathToFileURL(distBootstrapPath).href;
  const { runMswarmConsentBootstrap } = await import(moduleHref);
  await runMswarmConsentBootstrap({
    mode: isInstallLocal ? "install_local" : "postinstall",
    onDeferred: "log",
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
