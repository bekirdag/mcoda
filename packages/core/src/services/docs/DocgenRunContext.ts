import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";

export type DocgenCommandName = "docs-pdr-generate" | "docs-sds-generate";

export type DocArtifactKind = "pdr" | "sds" | "openapi" | "sql" | "deployment";

export type DocArtifactVariant = "primary" | "admin" | "unknown";

export interface DocArtifactMeta {
  sizeBytes?: number;
  modifiedAt?: string;
  docdexId?: string;
  segments?: string[];
  projectKey?: string;
}

export interface DocArtifactRecord {
  kind: DocArtifactKind;
  path: string;
  variant?: DocArtifactVariant;
  meta: DocArtifactMeta;
}

export interface DocgenArtifactInventory {
  pdr?: DocArtifactRecord;
  sds?: DocArtifactRecord;
  openapi: DocArtifactRecord[];
  sql?: DocArtifactRecord;
  blueprints: DocArtifactRecord[];
}

export interface DocgenIterationState {
  current: number;
  max: number;
}

export interface DocgenRunContext {
  version: 1;
  commandName: DocgenCommandName;
  commandRunId: string;
  jobId: string;
  workspace: WorkspaceResolution;
  projectKey?: string;
  rfpId?: string;
  rfpPath?: string;
  templateName?: string;
  outputPath: string;
  createdAt: string;
  flags: {
    dryRun: boolean;
    fast: boolean;
    iterate: boolean;
    json: boolean;
    stream: boolean;
    buildReady: boolean;
    noPlaceholders: boolean;
    resolveOpenQuestions: boolean;
    noMaybes: boolean;
    crossAlign: boolean;
  };
  iteration: DocgenIterationState;
  artifacts: DocgenArtifactInventory;
  stateWarnings?: string[];
  warnings: string[];
}

export const createEmptyArtifacts = (): DocgenArtifactInventory => ({
  openapi: [],
  blueprints: [],
});
