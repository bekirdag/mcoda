import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatWorkingStyle, workingStyleEnabled, WORKING_STYLE_HEADER } from "../WorkingStyle.js";
import { SessionController } from "../SessionController.js";
import { contractReviewFixture } from "../../eval/fixtures/ContractReviewProvider.js";
import type { Provider } from "../../providers/ProviderTypes.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

// Assembled at run time so the repository holds no string shaped like a real credential.
const SECRET_LIKE = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");
const items = [
  { category: "collaboration_style", text: "Finish the work end to end and leave it running; do not stop at analysis." },
  { category: "communication_style", text: "Keep answers short and direct." },
  { category: "communication_style", text: "keep answers  short and direct" },
  { category: "personal_context", text: "Lives in a coastal town." },
  { category: "quality_bar", text: "Reach me at someone@example.com when tests fail." },
  { category: "quality_bar", text: "Run the full test suite before deploying.", sensitivity: "private" },
  { category: "decision_style", text: "Ask my wife before buying hardware." },
  { category: "quality_bar", text: `Use key ${SECRET_LIKE} for checks.` },
  { category: "quality_bar", text: "Fix root causes, especially for problems that recur." },
];

test("only short, low-sensitivity style lines survive, deduplicated", () => {
  const style = formatWorkingStyle({ version: 1, profile_hash: "p1", items });
  assert.equal(style.included, 3); assert.equal(style.dropped, 6); assert.equal(style.profileHash, "p1");
  assert.ok(style.text.startsWith(WORKING_STYLE_HEADER));
  for (const kept of ["end to end", "short and direct", "root causes"]) assert.match(style.text, new RegExp(kept));
  for (const gone of ["coastal", "example.com", "full test suite", "wife", "sk_live"]) assert.doesNotMatch(style.text, new RegExp(gone));
  assert.equal(formatWorkingStyle({ content: [{ type: "text", text: JSON.stringify({ items }) }] }).included, 3);
  assert.equal(formatWorkingStyle({ items: [] }).text, "");
  assert.equal(formatWorkingStyle(undefined).text, "");
  assert.ok(formatWorkingStyle({ items }, WORKING_STYLE_HEADER.length + 80).included < 3);
});

test("working style is on by default and every off-switch wins", () => {
  assert.equal(workingStyleEnabled(undefined, undefined, undefined), true);
  assert.equal(workingStyleEnabled(undefined, false, undefined), false);
  assert.equal(workingStyleEnabled(undefined, true, "0"), false);
  assert.equal(workingStyleEnabled(undefined, undefined, "off"), false);
  assert.equal(workingStyleEnabled(false, true, "1"), false);
});

test("the working style reaches the model as lower-precedence guidance, and workingStyle: false keeps it out", { concurrency: false }, async t => {
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "style", providers: { service: { adapter: "openai-compatible", baseUrl: "https://model.test/v1" } },
    models: { lead: { provider: "service", catalogId: "lead", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } },
    bindings: { lead: { candidates: ["lead"] } }, interaction: { strategy: "native" } };
  const resolved = { config, hash: orchestrationHash(config), source: "test" };
  let styleCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); let payload: unknown = {};
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/v1/initialize") payload = { repo_id: "fixture" };
    if (url.pathname === "/v1/mcp") {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/call" && body.params?.name === "docdex_working_style") { styleCalls++; payload = { result: { version: 1, items } }; }
      else payload = { result: {} };
    }
    return Response.json(payload, { headers: { "mcp-session-id": "fixture-session" } });
  });
  for (const workingStyle of [undefined, false]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-style-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-style-state-"));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    const systems: string[] = [];
    const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
      const contract = contractReviewFixture(request); if (contract) return contract;
      systems.push(...request.messages.filter(message => message.role === "system").map(message => String(message.content)));
      return { message: { role: "assistant", content: "Hello." }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    } };
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdexUrl: "http://docdex.test", workingStyle });
    await controller.interact("Hello");
    await controller.interact("Thanks");
    const joined = systems.join("\n");
    if (workingStyle === false) assert.doesNotMatch(joined, /User working style/);
    else {
      assert.match(joined, /User working style \(from the user's local Docdex preferences/);
      assert.match(joined, /Fix root causes/);
      assert.doesNotMatch(joined, /example\.com|coastal|wife|sk_live/);
    }
  }
  assert.equal(styleCalls, 1, "fetched once per session and mode, never when turned off");
});
