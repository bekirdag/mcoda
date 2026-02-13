import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { getGlossaryEntry, loadGlossary } from "../Glossary.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface PdrOwnershipGateInput {
  artifacts: DocgenArtifactInventory;
}

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const extractSection = (
  lines: string[],
  headingMatch: RegExp,
): { content: string[]; line: number } | undefined => {
  let inFence = false;
  let capture = false;
  let startLine = 0;
  const collected: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const title = heading[1]?.trim() ?? "";
      if (headingMatch.test(title)) {
        capture = true;
        startLine = i + 1;
        continue;
      }
      if (capture) break;
    }
    if (capture && trimmed) collected.push(trimmed);
  }
  if (!capture) return undefined;
  return { content: collected, line: startLine };
};

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  path?: string;
  line?: number;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-pdr-ownership-consent-flow",
  severity: "high",
  category: "completeness",
  artifact: "pdr",
  message: input.message,
  remediation: input.remediation,
  location: input.path
    ? {
        kind: "line_range",
        path: input.path,
        lineStart: input.line ?? 1,
        lineEnd: input.line ?? 1,
        excerpt: input.message,
      }
    : { kind: "heading", heading: "PDR", path: input.path },
  metadata: input.metadata,
});

const mentionsOwnership = (lines: string[]): boolean =>
  lines.some((line) => /owner|steward|responsible|approval/i.test(line));

const mentionsCachePolicy = (lines: string[]): boolean =>
  lines.some((line) => /policy|cache rules?|governance|approval/i.test(line));

const mentionsConsentTtl = (lines: string[]): boolean =>
  lines.some((line) => /ttl|time[- ]to[- ]live|expiration|expiry/i.test(line));

const mentionsConsentRevoke = (lines: string[]): boolean =>
  lines.some((line) => /revoke|revocation|invalidate|rotation/i.test(line));

const mentionsCanonicalConsentToken = (lines: string[], canonical: string): boolean =>
  lines.some((line) => line.toLowerCase().includes(canonical.toLowerCase()));

const mentionsAlias = (lines: string[], aliases: string[]): string | undefined => {
  for (const alias of aliases) {
    if (lines.some((line) => line.toLowerCase().includes(alias.toLowerCase()))) {
      return alias;
    }
  }
  return undefined;
};

export const runPdrOwnershipGate = async (
  input: PdrOwnershipGateInput,
): Promise<ReviewGateResult> => {
  const pdr = input.artifacts.pdr;
  if (!pdr) {
    return {
      gateId: "gate-pdr-ownership-consent-flow",
      gateName: "PDR Ownership & Consent Flow",
      status: "skipped",
      issues: [],
      notes: ["No PDR artifact available for ownership/consent validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  const glossary = loadGlossary();
  const consentEntry = getGlossaryEntry("consent_token", glossary);
  const canonicalConsent = consentEntry?.term ?? "consent token";
  const consentAliases = consentEntry?.aliases ?? [];

  try {
    const content = await fs.readFile(pdr.path, "utf8");
    const lines = content.split(/\r?\n/);

    const ownershipSection = extractSection(lines, /ownership|governance|policy/i);
    const consentSection = extractSection(lines, /consent|token issuance|installation/i);

    if (!ownershipSection) {
      issues.push(
        buildIssue({
          id: "gate-pdr-ownership-consent-flow-missing-ownership",
          message: "PDR is missing an ownership/governance section.",
          remediation: "Add a section stating ownership of policy changes and cache rules.",
          path: pdr.path,
          metadata: { issueType: "missing_ownership_section" },
        }),
      );
    } else {
      if (!mentionsOwnership(ownershipSection.content) || !mentionsCachePolicy(ownershipSection.content)) {
        issues.push(
          buildIssue({
            id: "gate-pdr-ownership-consent-flow-vague-ownership",
            message: "Ownership section does not specify policy/cache rule owners.",
            remediation: "Name the policy owner responsible for cache rules and approvals.",
            path: pdr.path,
            line: ownershipSection.line,
            metadata: { issueType: "vague_ownership" },
          }),
        );
      }
    }

    if (!consentSection) {
      issues.push(
        buildIssue({
          id: "gate-pdr-ownership-consent-flow-missing-consent",
          message: "PDR is missing a consent flow section.",
          remediation: "Add a consent flow summary covering issuance, TTL, and revocation.",
          path: pdr.path,
          metadata: { issueType: "missing_consent_flow" },
        }),
      );
    } else {
      if (!mentionsConsentTtl(consentSection.content)) {
        issues.push(
          buildIssue({
            id: "gate-pdr-ownership-consent-flow-missing-ttl",
            message: "Consent flow section does not mention token TTL/expiration.",
            remediation: "Specify TTL or expiration behavior for the consent token.",
            path: pdr.path,
            line: consentSection.line,
            metadata: { issueType: "missing_ttl" },
          }),
        );
      }
      if (!mentionsConsentRevoke(consentSection.content)) {
        issues.push(
          buildIssue({
            id: "gate-pdr-ownership-consent-flow-missing-revoke",
            message: "Consent flow section does not mention revocation behavior.",
            remediation: "Describe how consent tokens can be revoked or invalidated.",
            path: pdr.path,
            line: consentSection.line,
            metadata: { issueType: "missing_revoke" },
          }),
        );
      }
      if (consentEntry) {
        const usesCanonical = mentionsCanonicalConsentToken(consentSection.content, canonicalConsent);
        const alias = mentionsAlias(consentSection.content, consentAliases);
        if (!usesCanonical && alias) {
          issues.push(
            buildIssue({
              id: "gate-pdr-ownership-consent-flow-noncanonical-term",
              message: `Consent flow uses non-canonical term "${alias}" instead of "${canonicalConsent}".`,
              remediation: `Replace "${alias}" with "${canonicalConsent}" to align with glossary terms.`,
              path: pdr.path,
              line: consentSection.line,
              metadata: { issueType: "noncanonical_term", alias, canonicalConsent },
            }),
          );
        }
      }
    }
  } catch (error) {
    notes.push(`Unable to read PDR ${pdr.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-pdr-ownership-consent-flow",
    gateName: "PDR Ownership & Consent Flow",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
