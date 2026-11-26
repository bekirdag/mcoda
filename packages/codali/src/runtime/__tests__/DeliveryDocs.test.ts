import test from "node:test";
import assert from "node:assert/strict";
import { deliveryClaims, isDeliveryDocument, missingDeliveryDocuments, ungroundedDurations } from "../DeliveryDocs.js";

// Fresh variants written for this check: a password-reset service, a Flask
// rota planner and a kiosk app. None comes from a benchmark task.
const resetService = {
  path: "src/reset.ts",
  text: "export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;\nexport const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;\nconst attempts = 5;\n",
};

test("a document stating a different lifetime than the code's setting is reported with the related setting", () => {
  const doc = { path: "OPERATIONS.md", text: "# Operations\n\n- Reset links expire after 30 minutes.\n- Lockout window: 15 min after 5 failed attempts.\n" };
  const findings = ungroundedDurations([doc], [resetService], []);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^OPERATIONS\.md:3 states 30 minutes/);
  assert.match(findings[0], /src\/reset\.ts:1 export const RESET_TOKEN_TTL_MS = 60 \* 60 \* 1000/);
});

test("the same lifetime in another unit, a unit string or a keyword argument is grounded", () => {
  const doc = (line: string) => [{ path: "README.md", text: line }];
  assert.deepEqual(ungroundedDurations(doc("Reset tokens expire after 1 hour."), [resetService], []), []);
  assert.deepEqual(ungroundedDurations(doc("Reset tokens expire after 3600 seconds."), [resetService], []), []);
  assert.deepEqual(ungroundedDurations(doc("Signed shift links stay valid for 2 hours."),
    [{ path: "rota/links.py", text: "LINK_LIFETIME = timedelta(hours=2)\n" }], []), []);
  assert.deepEqual(ungroundedDurations(doc("The kiosk session times out after 90s idle."),
    [{ path: "config/kiosk.yaml", text: "idle_timeout: '90s'\n" }], []), []);
  assert.deepEqual(ungroundedDurations(doc("The kiosk session times out after 90s idle."), [],
    ["PASS kiosk signs out after 90 seconds idle"]), [], "a receipt that shows the value grounds it");
});

test("incidental durations, test files and the document itself do not ground or trigger findings", () => {
  assert.deepEqual(ungroundedDurations([{ path: "README.md", text: "The full test run takes about 3 minutes." }], [resetService], []), []);
  const findings = ungroundedDurations([{ path: "README.md", text: "Reset tokens expire after 30 minutes." }],
    [resetService, { path: "test/reset.test.ts", text: "const RESET_TTL_MS = 30 * 60 * 1000;" }, { path: "docs/notes.md", text: "ttl 30 minutes" }], []);
  assert.equal(findings.length, 1);
});

test("delivery documents named by the request but not yet written are listed; inputs and existing files are not", () => {
  const goal = "Build the rota planner described in BRIEF.md. Deliver README.md, docs/OPERATIONS.md and a `HANDOVER.md` with known limits.";
  assert.deepEqual(missingDeliveryDocuments([goal], ["readme.md"], ["BRIEF.md"]), ["docs/OPERATIONS.md", "HANDOVER.md"]);
  assert.equal(isDeliveryDocument("docs/OPERATIONS.md"), true);
  assert.equal(isDeliveryDocument("requirements.txt"), false);
  assert.equal(isDeliveryDocument("node_modules/x/README.md"), false);
});

test("claims are prose lines and list items, not headings, fences or table rules", () => {
  const text = "# Kiosk\n\n```sh\nnpm start -- --port 8080\n```\n| a | b |\n|---|---|\n- Staff can void a sale within the shift.\n1. Run npm start to open the kiosk.\nOK.\n";
  assert.deepEqual(deliveryClaims(text), ["| a | b |", "Staff can void a sale within the shift.", "Run npm start to open the kiosk."]);
});
