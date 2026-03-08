import test from "node:test";
import assert from "node:assert/strict";
import { collectSdsImplementationSignals } from "../SdsStructureSignals.js";

test("collectSdsImplementationSignals strips managed preflight blocks and preserves unique headings after duplicate noise", () => {
  const content = [
    "<!-- mcoda:sds-preflight:start -->",
    "## Open Questions",
    "## Placeholder Tree",
    "```text",
    "read/write",
    "```",
    "<!-- mcoda:sds-preflight:end -->",
    "# Software Design Specification",
    "## Observability",
    "## Observability",
    "## Observability",
    "## Gatekeeper Runtime",
  ].join("\n");

  const signals = collectSdsImplementationSignals(content, {
    headingLimit: 2,
    folderLimit: 4,
  });

  assert.deepEqual(signals.sectionHeadings, ["Observability", "Gatekeeper Runtime"]);
  assert.equal(signals.rawSectionHeadings.includes("Open Questions"), false);
});

test("collectSdsImplementationSignals preserves box-tree implementation paths and filters pseudo action paths", () => {
  const content = [
    "# Software Design Specification",
    "## Deployment Waves",
    "Capabilities include read/write and submit/remove flows in the user narrative only.",
    "```text",
    ".",
    "├── contracts/",
    "│   ├── script/",
    "│   │   └── DeployContracts.s.sol",
    "│   └── src/",
    "│       └── OracleRegistry.sol",
    "├── packages/",
    "│   └── gatekeeper/",
    "│       └── src/",
    "│           └── worker.ts",
    "└── ops/",
    "    └── systemd/",
    "        └── gatekeeper.service",
    "```",
  ].join("\n");

  const signals = collectSdsImplementationSignals(content, {
    headingLimit: 8,
    folderLimit: 12,
  });

  assert.equal(signals.folderEntries.includes("read/write"), false);
  assert.equal(signals.folderEntries.includes("submit/remove"), false);
  assert.equal(signals.folderEntries.includes("contracts/script/DeployContracts.s.sol"), true);
  assert.equal(signals.folderEntries.includes("contracts/src/OracleRegistry.sol"), true);
  assert.equal(signals.folderEntries.includes("packages/gatekeeper/src/worker.ts"), true);
  assert.equal(signals.folderEntries.includes("ops/systemd/gatekeeper.service"), true);
});

test("collectSdsImplementationSignals prunes parent numbered implementation headings when more specific children exist", () => {
  const content = [
    "# Software Design Specification",
    "3 Service Architecture",
    "3.1 Gatekeeper Service",
    "3.2 Terminal Client Service",
  ].join("\n");

  const signals = collectSdsImplementationSignals(content, {
    headingLimit: 6,
    folderLimit: 0,
  });

  assert.deepEqual(signals.sectionHeadings, ["Gatekeeper Service", "Terminal Client Service"]);
});
