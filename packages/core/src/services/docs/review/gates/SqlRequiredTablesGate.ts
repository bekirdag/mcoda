import path from "node:path";
import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface SqlRequiredTablesGateInput {
  artifacts: DocgenArtifactInventory;
}

type FeatureKey = "data_exports" | "rights_policies" | "admin_audit" | "event_outbox";

interface FeatureDefinition {
  key: FeatureKey;
  label: string;
  matchers: string[];
  requiredTables: string[];
}

interface FeatureMatch {
  record: DocArtifactRecord;
  line: number;
  excerpt: string;
}

const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  {
    key: "data_exports",
    label: "data exports",
    matchers: ["data export", "export job", "export artifact", "dataset export"],
    requiredTables: ["data_export_jobs", "data_export_artifacts"],
  },
  {
    key: "rights_policies",
    label: "rights policies",
    matchers: ["rights policy", "rights policies"],
    requiredTables: ["rights_policies"],
  },
  {
    key: "admin_audit",
    label: "admin audit logs",
    matchers: ["admin audit", "audit admin", "admin audit log"],
    requiredTables: ["admin_audit_log"],
  },
  {
    key: "event_outbox",
    label: "event outbox",
    matchers: ["event outbox", "outbox", "event bus", "message bus", "pub sub"],
    requiredTables: ["event_outbox"],
  },
];

const CREATE_TABLE_PATTERN =
  /\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?([`\"\\[]?[A-Za-z0-9_]+[`\"\\]]?)/i;

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const normalizeDocLine = (line: string): string =>
  line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const stripSqlComments = (line: string, state: { inBlockComment: boolean }): string => {
  let working = line;
  if (state.inBlockComment) {
    const end = working.indexOf("*/");
    if (end === -1) return "";
    working = working.slice(end + 2);
    state.inBlockComment = false;
  }
  let blockStart = working.indexOf("/*");
  while (blockStart !== -1) {
    const blockEnd = working.indexOf("*/", blockStart + 2);
    if (blockEnd === -1) {
      working = working.slice(0, blockStart);
      state.inBlockComment = true;
      break;
    }
    working = `${working.slice(0, blockStart)} ${working.slice(blockEnd + 2)}`;
    blockStart = working.indexOf("/*", blockStart);
  }
  const lineComment = working.indexOf("--");
  if (lineComment !== -1) {
    working = working.slice(0, lineComment);
  }
  return working.trim();
};

const collectFeatureMatches = async (
  records: DocArtifactRecord[],
): Promise<Record<FeatureKey, FeatureMatch[]>> => {
  const matches: Record<FeatureKey, FeatureMatch[]> = {
    data_exports: [],
    rights_policies: [],
    admin_audit: [],
    event_outbox: [],
  };

  for (const record of records) {
    try {
      const content = await fs.readFile(record.path, "utf8");
      const lines = content.split(/\\r?\\n/);
      let inFence = false;
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (isFenceLine(trimmed)) {
          inFence = !inFence;
          return;
        }
        if (inFence) return;
        const normalized = normalizeDocLine(line);
        if (!normalized) return;
        for (const feature of FEATURE_DEFINITIONS) {
          if (feature.matchers.some((matcher) => normalized.includes(matcher))) {
            matches[feature.key].push({
              record,
              line: index + 1,
              excerpt: trimmed.slice(0, 140),
            });
          }
        }
      });
    } catch {
      // ignore missing doc reads; handled by gate notes
    }
  }

  return matches;
};

const normalizeTableName = (value: string): string =>
  value.replace(/[`\"\\[]|\\]$/g, "").toLowerCase();

const stripSqlCommentsFromRaw = (raw: string): string =>
  raw.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, " ");

const collectTableNamesFromRaw = (raw: string): Set<string> => {
  const tables = new Set<string>();
  const sanitized = stripSqlCommentsFromRaw(raw);
  const pattern =
    /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([`"\[]?[A-Za-z0-9_]+[`"\]]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sanitized)) !== null) {
    if (match[1]) tables.add(normalizeTableName(match[1]));
  }
  return tables;
};

const collectBadRightsPolicyFk = (
  lines: string[],
): Array<{ line: number; excerpt: string }> => {
  const results: Array<{ line: number; excerpt: string }> = [];
  const state = { inBlockComment: false };
  lines.forEach((line, index) => {
    const code = stripSqlComments(line, state);
    if (!code) return;
    if (/\\brights_policies_id\\b/i.test(code)) {
      results.push({ line: index + 1, excerpt: code.trim().slice(0, 140) });
    }
  });
  return results;
};

const collectBadRightsPolicyFkFromRaw = (
  raw: string,
): Array<{ line: number; excerpt: string }> => {
  const results: Array<{ line: number; excerpt: string }> = [];
  const pattern = /\brights_policies_id\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const prefix = raw.slice(0, match.index);
    const line = prefix.split(/\r?\n/).length;
    const lineText = raw.split(/\r?\n/)[line - 1] ?? raw.slice(match.index);
    results.push({ line, excerpt: lineText.trim().slice(0, 140) });
  }
  return results;
};

const formatEvidence = (matches: FeatureMatch[]): string | undefined => {
  if (matches.length === 0) return undefined;
  const preview = matches
    .slice(0, 2)
    .map((match) => `${path.basename(match.record.path)}:${match.line}`)
    .join(", ");
  const suffix = matches.length > 2 ? ` (+${matches.length - 2} more)` : "";
  return `${preview}${suffix}`;
};

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  record: DocArtifactRecord;
  line?: number;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-sql-required-tables",
  severity: "high",
  category: "sql",
  artifact: "sql",
  message: input.message,
  remediation: input.remediation,
  location: {
    kind: "line_range",
    path: input.record.path,
    lineStart: input.line ?? 1,
    lineEnd: input.line ?? 1,
    excerpt: input.message,
  },
  metadata: input.metadata,
});

export const runSqlRequiredTablesGate = async (
  input: SqlRequiredTablesGateInput,
): Promise<ReviewGateResult> => {
  const sql = input.artifacts.sql;
  if (!sql) {
    return {
      gateId: "gate-sql-required-tables",
      gateName: "SQL Required Tables",
      status: "skipped",
      issues: [],
      notes: ["No SQL artifact available for required table validation."],
    };
  }

  const docRecords = [input.artifacts.sds, input.artifacts.pdr].filter(
    (record): record is DocArtifactRecord => Boolean(record),
  );
  if (docRecords.length === 0) {
    return {
      gateId: "gate-sql-required-tables",
      gateName: "SQL Required Tables",
      status: "skipped",
      issues: [],
      notes: ["No SDS/PDR artifacts available for SQL requirement detection."],
    };
  }

  const notes: string[] = [];
  const issues: ReviewIssue[] = [];

  const featureMatches = await collectFeatureMatches(docRecords);
  const activeFeatures = FEATURE_DEFINITIONS.filter(
    (feature) => featureMatches[feature.key].length > 0,
  );

  if (activeFeatures.length === 0) {
    return {
      gateId: "gate-sql-required-tables",
      gateName: "SQL Required Tables",
      status: "pass",
      issues: [],
      notes: ["No feature-driven SQL requirements detected in docs."],
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(sql.path, "utf8");
  } catch (error) {
    return {
      gateId: "gate-sql-required-tables",
      gateName: "SQL Required Tables",
      status: "pass",
      issues: [],
      notes: [`Unable to read SQL schema ${sql.path}: ${(error as Error).message ?? String(error)}`],
    };
  }

  const lines = raw.split(/\\r?\\n/);
  const tables = collectTableNamesFromRaw(raw);
  const hasOutbox = Array.from(tables).some((name) => name.includes("outbox"));
  const hasAdminAudit =
    tables.has("admin_audit_log") || tables.has("admin_audit_logs");

  for (const feature of activeFeatures) {
    const evidence = formatEvidence(featureMatches[feature.key]);
    for (const table of feature.requiredTables) {
      if (feature.key === "event_outbox") {
        if (hasOutbox) continue;
      } else if (feature.key === "admin_audit") {
        if (hasAdminAudit) continue;
      } else if (tables.has(table)) {
        continue;
      }

      const message = evidence
        ? `SQL schema is missing required table \"${table}\" for ${feature.label} (referenced at ${evidence}).`
        : `SQL schema is missing required table \"${table}\" for ${feature.label}.`;
      issues.push(
        buildIssue({
          id: `gate-sql-required-tables-${feature.key}-${table}`,
          message,
          remediation: `Add the ${table} table to the SQL schema.`,
          record: sql,
          metadata: { issueType: "missing_table", feature: feature.key, table, evidence },
        }),
      );
    }
  }

  const shouldCheckRightsFk =
    featureMatches.rights_policies.length > 0 || tables.has("rights_policies");
  if (shouldCheckRightsFk) {
    const badFks = collectBadRightsPolicyFk(lines);
    const fkHits = badFks.length > 0 ? badFks : collectBadRightsPolicyFkFromRaw(raw);
    for (const bad of fkHits) {
      issues.push(
        buildIssue({
          id: `gate-sql-required-tables-rights-policy-fk-${bad.line}`,
          message:
            "SQL schema uses \"rights_policies_id\"; use \"rights_policy_id\" for FK columns.",
          remediation: "Rename FK columns to rights_policy_id and update references.",
          record: sql,
          line: bad.line,
          metadata: { issueType: "fk_naming", expected: "rights_policy_id", found: "rights_policies_id" },
        }),
      );
    }
  }

  if (issues.length === 0) {
    const features = activeFeatures.map((feature) => feature.label).join(", ");
    notes.push(`SQL requirement checks passed for: ${features}.`);
  }

  return {
    gateId: "gate-sql-required-tables",
    gateName: "SQL Required Tables",
    status: issues.length > 0 ? "fail" : "pass",
    issues,
    notes: notes.length > 0 ? notes : undefined,
    metadata: {
      featureCount: activeFeatures.length,
      tableCount: tables.size,
    },
  };
};
