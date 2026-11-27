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

test("a value on an unrelated setting line does not ground a lifetime", () => {
  const kiosk = { path: "src/kiosk.ts", text: "export const KIOSK_SESSION_MS = 4 * 60 * 60 * 1000;\nexport const MAX_UPLOAD_RETRIES = 6; // per hour\n" };
  const findings = ungroundedDurations([{ path: "DELIVERY.md", text: "Kiosk sessions last 6 hours." }], [kiosk], []);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^DELIVERY\.md:1 states 6 hours .*src\/kiosk\.ts:1 export const KIOSK_SESSION_MS/);
  assert.deepEqual(ungroundedDurations([{ path: "DELIVERY.md", text: "Kiosk sessions last 4 hours." }], [kiosk], []), []);
});

test("run times and a named library's own defaults are not settings claims", () => {
  const sources = [{ path: "src/cache.ts", text: "export const CACHE_TTL_MS = 5 * 60 * 1000;\n" }];
  assert.deepEqual(ungroundedDurations([{ path: "README.md", text: "The e2e suite takes about 45 seconds; the cache token check runs in 2 seconds." }], sources, []), []);
  assert.deepEqual(ungroundedDurations([{ path: "README.md", text: "Connections use the Redis client's default connect timeout of 10 seconds." }], sources, []), []);
  assert.equal(ungroundedDurations([{ path: "README.md", text: "Cached quotes expire after 10 minutes." }], sources, []).length, 1);
});

test("documents the request only refers to are not required deliverables", () => {
  const goal = "Build the ticket desk. Follow the conventions in the upstream SECURITY.md and see GUIDE.md for tone. Write OPERATIONS.md with the start steps.";
  assert.deepEqual(missingDeliveryDocuments([goal], [], []), ["OPERATIONS.md"]);
  assert.deepEqual(missingDeliveryDocuments(["Document setup in SETUP.md."], [], []), ["SETUP.md"]);
});

test("deliverable lists, 'the following' and should/must phrasing name required documents", () => {
  assert.deepEqual(missingDeliveryDocuments(["# Clinic rota\n\nDeliverables:\n- HANDBOOK.md\n- RUNBOOK.md\n\nNotes:\n- see LEGACY.md"], [], []), ["HANDBOOK.md", "RUNBOOK.md"]);
  assert.deepEqual(missingDeliveryDocuments(["Write the following RELEASE.md with the upgrade steps."], [], []), ["RELEASE.md"]);
  assert.deepEqual(missingDeliveryDocuments(["The rota service should contain a SUPPORT.md."], [], []), ["SUPPORT.md"]);
  assert.deepEqual(missingDeliveryDocuments(["A HANDOFF.md must explain the start steps."], [], []), ["HANDOFF.md"]);
});
