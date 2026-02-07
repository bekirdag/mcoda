import { DocArtifactKind, DocArtifactVariant } from "../DocgenRunContext.js";

export type DocAlignmentArtifactKind = DocArtifactKind | "rfp" | "telemetry";

export interface DocAlignmentNode {
  artifact: DocAlignmentArtifactKind;
  section: string;
  variant?: DocArtifactVariant;
}

export interface DocAlignmentRule {
  id: string;
  description: string;
  sources: DocAlignmentNode[];
  targets: DocAlignmentNode[];
  tags?: string[];
}

const DEFAULT_RULES: DocAlignmentRule[] = [
  {
    id: "consent-model",
    description: "Consent and minimization policies propagate across docs.",
    sources: [{ artifact: "rfp", section: "Consent & Minimization" }],
    targets: [
      { artifact: "pdr", section: "Ownership & Consent Flow" },
      { artifact: "sds", section: "Policy & Telemetry" },
      { artifact: "openapi", variant: "primary", section: "Security Schemes" },
      { artifact: "openapi", variant: "admin", section: "Security Schemes" },
      { artifact: "telemetry", section: "Consent Metadata" },
    ],
  },
  {
    id: "api-prefix",
    description: "Canonical API prefixes should align across docs and specs.",
    sources: [
      { artifact: "pdr", section: "Interfaces / APIs" },
      { artifact: "sds", section: "Interface Contracts" },
    ],
    targets: [
      { artifact: "pdr", section: "Interfaces / APIs" },
      { artifact: "sds", section: "Interface Contracts" },
      { artifact: "openapi", variant: "primary", section: "Paths" },
      { artifact: "openapi", variant: "admin", section: "Paths" },
    ],
  },
  {
    id: "terminology",
    description: "Canonical terminology and naming conventions stay aligned.",
    sources: [{ artifact: "rfp", section: "Definitions" }],
    targets: [
      { artifact: "pdr", section: "Terminology" },
      { artifact: "sds", section: "Terminology" },
      { artifact: "sql", section: "Schema" },
      { artifact: "openapi", variant: "primary", section: "Schemas" },
      { artifact: "openapi", variant: "admin", section: "Schemas" },
    ],
  },
];

const nodeKey = (node: DocAlignmentNode): string => {
  return `${node.artifact}:${node.variant ?? ""}:${node.section}`;
};

const sortNodes = (nodes: DocAlignmentNode[]): DocAlignmentNode[] => {
  return nodes.slice().sort((a, b) => {
    const artifactDiff = a.artifact.localeCompare(b.artifact);
    if (artifactDiff !== 0) return artifactDiff;
    const variantDiff = (a.variant ?? "").localeCompare(b.variant ?? "");
    if (variantDiff !== 0) return variantDiff;
    return a.section.localeCompare(b.section);
  });
};

export class DocAlignmentGraph {
  private rules: Map<string, DocAlignmentRule>;

  constructor(rules: DocAlignmentRule[]) {
    this.rules = new Map(rules.map((rule) => [rule.id, rule]));
  }

  static createDefault(): DocAlignmentGraph {
    return new DocAlignmentGraph(DEFAULT_RULES);
  }

  listRules(): DocAlignmentRule[] {
    return Array.from(this.rules.values());
  }

  getRule(ruleId: string): DocAlignmentRule | undefined {
    return this.rules.get(ruleId);
  }

  getImpactedSections(ruleId: string): DocAlignmentNode[] {
    const rule = this.rules.get(ruleId);
    if (!rule) return [];
    const deduped = new Map<string, DocAlignmentNode>();
    for (const node of rule.targets) {
      deduped.set(nodeKey(node), node);
    }
    return sortNodes(Array.from(deduped.values()));
  }
}
