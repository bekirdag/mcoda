import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider, ProviderResponse } from "../../providers/ProviderTypes.js";
import { getGlobalWorkspaceDir } from "../../runtime/StoragePaths.js";
import { PostMortemAnalyzer } from "../PostMortemAnalyzer.js";

class StubProvider {
  constructor(private content: string) {}

  async generate(): Promise<ProviderResponse> {
    return {
      message: { role: "assistant", content: this.content },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const withHomeDir = async (homeDir: string, fn: () => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    await fn();
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  }
};

const seedRunArtifacts = (params: {
  workspaceRoot: string;
  homeDir: string;
  runId: string;
  touchedFile: string;
  patchPayload: string;
  request: string;
}): void => {
  const storageRoot = getGlobalWorkspaceDir(params.workspaceRoot);
  const logDir = path.join(storageRoot, "logs");
  const phaseDir = path.join(logDir, "phase");
  mkdirSync(phaseDir, { recursive: true });

  const requestArtifactPath = path.join(phaseDir, `${params.runId}-librarian-input-1.json`);
  writeFileSync(
    requestArtifactPath,
    JSON.stringify(
      {
        schema_version: 1,
        phase: "librarian",
        kind: "input",
        payload: { request: params.request },
      },
      null,
      2,
    ),
    "utf8",
  );

  const patchArtifactPath = path.join(phaseDir, `${params.runId}-builder-builder-patch-1.json`);
  writeFileSync(
    patchArtifactPath,
    JSON.stringify(
      {
        schema_version: 1,
        phase: "builder",
        kind: "builder-patch",
        payload: { patches: [{ path: params.touchedFile, replace: params.patchPayload }] },
      },
      null,
      2,
    ),
    "utf8",
  );

  const runLogPath = path.join(logDir, `${params.runId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "phase_input",
      timestamp: new Date().toISOString(),
      data: {
        phase: "librarian",
        path: requestArtifactPath,
      },
    }),
    JSON.stringify({
      type: "run_summary",
      timestamp: new Date().toISOString(),
      data: {
        runId: params.runId,
        touchedFiles: [params.touchedFile],
      },
    }),
  ];
  writeFileSync(runLogPath, `${lines.join("\n")}\n`, "utf8");
};

test("PostMortemAnalyzer returns no_change when analyzer emits NO_CHANGE", {
  concurrency: false,
}, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-postmortem-workspace-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-postmortem-home-"));
  const targetFile = path.join(workspaceRoot, "src", "index.ts");
  mkdirSync(path.dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, "export const value = 1;\n", "utf8");

  await withHomeDir(homeDir, async () => {
    seedRunArtifacts({
      workspaceRoot,
      homeDir,
      runId: "run-no-change",
      touchedFile: "src/index.ts",
      patchPayload: "export const value = 1;",
      request: "Update the exported value in src/index.ts",
    });

    const analyzer = new PostMortemAnalyzer(
      new StubProvider("NO_CHANGE") as unknown as Provider,
      workspaceRoot,
    );
    const result = await analyzer.analyze(targetFile);
    assert.equal(result.status, "no_change");
    assert.equal(result.rules.length, 0);
  });
});

test("PostMortemAnalyzer produces governed rule proposal with evidence", {
  concurrency: false,
}, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-postmortem-workspace-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "codali-postmortem-home-"));
  const targetFile = path.join(workspaceRoot, "src", "index.ts");
  mkdirSync(path.dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, "export const value = 2;\n", "utf8");

  await withHomeDir(homeDir, async () => {
    seedRunArtifacts({
      workspaceRoot,
      homeDir,
      runId: "run-with-rule",
      touchedFile: "src/index.ts",
      patchPayload: "export const value = 1;",
      request: "Update the exported value in src/index.ts",
    });

    const analyzer = new PostMortemAnalyzer(
      new StubProvider("Do not remove exports from helper files.") as unknown as Provider,
      workspaceRoot,
    );
    const result = await analyzer.analyze(targetFile);
    assert.equal(result.status, "rule_extracted");
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0]?.category, "constraint");
    assert.equal(result.rules[0]?.scope, "profile_memory");
    assert.equal(typeof result.rules[0]?.confidence_score, "number");
    assert.ok((result.rules[0]?.evidence?.length ?? 0) >= 3);
  });
});

test("PostMortemAnalyzer throws when no matching run is found", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-postmortem-workspace-"));
  const targetFile = path.join(workspaceRoot, "src", "index.ts");
  mkdirSync(path.dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, "export const value = 1;\n", "utf8");

  const analyzer = new PostMortemAnalyzer(
    new StubProvider("Do not remove exports from helper files.") as unknown as Provider,
    workspaceRoot,
  );
  await assert.rejects(async () => {
    await analyzer.analyze(targetFile);
  }, /No recent Codali run found/);
});
