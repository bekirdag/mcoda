#!/usr/bin/env node
// Explicit live evaluation: no workspace tools and no user-file changes.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadOrchestrationConfig } from "../packages/codali/dist/config/OrchestrationConfig.js";
import { ConfiguredProvider } from "../packages/codali/dist/providers/ConfiguredProvider.js";
import { interactionSettings, parseInteractionDecision } from "../packages/codali/dist/runtime/InteractionRouter.js";
import { redactSecretValues } from "../packages/codali/dist/runtime/SecretRedaction.js";

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
if (!option("--config") || !option("--out")) throw new Error("Usage: node scripts/eval-codali-interactions.mjs --config PATH --out NEW_PRIVATE_JSONL [--binding NAME]");
const resolved = await loadOrchestrationConfig(option("--config"));
const settings = interactionSettings(resolved.config.interaction);
const provider = new ConfiguredProvider(resolved, option("--binding") ?? settings.routerBinding);
const output = path.resolve(option("--out"));
await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await fs.writeFile(output, "", { mode: 0o600, flag: "wx" });
const cases = [
  ["greeting", [], "hello", ["answer"]],
  ["greeting-other-language", [], "Bonjour ! Comment ça va ?", ["answer"]],
  ["thanks", [], "Thanks, that is enough.", ["answer"]],
  ["arithmetic", [], "What is 17 times 23?", ["answer", "reason"]],
  ["programming-question", [], "Explain a JavaScript Promise with a short example.", ["reason"]],
  ["workspace-question", [], "Where is the login handler in this repository?", ["inspect"]],
  ["action", [], "Fix src/client.ts timeout handling and run its tests.", ["execute"]],
  ["fresh-continue", [], "continue", ["clarify"]],
  ["contextual-action", [{ role: "user", content: "Please fix the typo in README.md." }, { role: "assistant", content: "I found teh instead of the on line 4." }], "go ahead", ["execute"]],
  ["contextual-answer", [{ role: "user", content: "Explain JavaScript promises." }, { role: "assistant", content: "Would you like a code example?" }], "go ahead", ["reason"]],
  ["code-follow-up", [{ role: "user", content: "Show a JavaScript Promise example." }, { role: "assistant", content: "new Promise(resolve => setTimeout(() => resolve('Done'), 100)).then(console.log);" }], "Make it shorter.", ["reason"]],
  ["side-question", [{ role: "user", content: "Fix src/client.ts." }, { role: "assistant", content: "I am investigating the failure." }], "What is two plus two?", ["answer", "reason"]],
  ["question-not-permission", [], "Explain rm -rf build. Do not execute it.", ["answer", "reason"]],
  ["quoted-greeting", [], "The greeting 'hello' triggers a loop. Diagnose the code without editing it.", ["inspect"]],
  ["missing-referent", [], "Can you fix it?", ["clarify"]],
  ["careful-reasoning", [], "Compare serializability and snapshot isolation, with a rigorous write-skew schedule example.", ["reason"]],
];
let passed = 0, tokens = 0;
for (const [id, history, message, expected] of cases) {
  const requestId = randomUUID(), start = Date.now();
  const request = { requestId, messages: [{ role: "system", content: settings.routerPrompt }, { role: "user", content: JSON.stringify({ workspace: "/evaluation/workspace", activeGoal: null, history, message }) }], maxTokens: settings.maxOutputTokens, temperature: 0, responseFormat: { type: "json" }, signal: AbortSignal.timeout(settings.timeoutMs) };
  let response, decision, error;
  try { response = await provider.generate(request); decision = parseInteractionDecision(response.message.content); }
  catch (failure) { error = String(failure); }
  const pass = !!decision && expected.includes(decision.mode);
  passed += Number(pass); tokens += response?.usage?.totalTokens ?? 0;
  const row = { id, requestId, expected, request: { ...request, signal: undefined }, response, decision, error, pass, elapsedMs: Date.now() - start, configHash: resolved.hash, promptVersion: settings.promptVersion };
  await fs.appendFile(output, redactSecretValues(JSON.stringify(row)) + "\n");
  console.log(JSON.stringify({ id, pass, mode: decision?.mode, tokens: response?.usage?.totalTokens, elapsedMs: row.elapsedMs, error }));
}
console.log(JSON.stringify({ passed, total: cases.length, tokens, log: output, note: "Mode/schema checks do not replace review of answer correctness or live execution tests." }));
if (passed !== cases.length) process.exitCode = 1;
