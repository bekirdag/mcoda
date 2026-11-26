import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionController, type SessionEvent, type SessionControllerOptions } from "../SessionController.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { DocdexClient } from "../../docdex/DocdexClient.js";

// Fresh variants written for the .43 audit fixes (greenhouse telemetry design,
// ferry-service research); none comes from a benchmark task.

const base: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } }, models: { model: { provider: "local", catalogId: "test", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } }, bindings: { lead: { candidates: ["model"] }, router: { useBinding: "lead" }, reviewer: { useBinding: "lead" } } };
const reply = (content: string, outputTokens = 20): ProviderResponse => ({ message: { role: "assistant", content }, usage: { inputTokens: 300, outputTokens, totalTokens: 300 + outputTokens } });
const fixture = async (t: test.TestContext, provider: Provider, config: OrchestrationConfig, options: Partial<SessionControllerOptions> = {}, docdex = false) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codali-audit-")));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-audit-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  const events: SessionEvent[] = [];
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved: { config, hash: orchestrationHash(config), source: "test" }, provider, docdex, userInstructionsPath: false, onEvent: e => events.push(e), ...options });
  return { controller, events };
};
const designConfig = () => {
  const config = structuredClone(base);
  config.interaction = { strategy: "adaptive", maxModelCalls: 10, maxTotalTokens: 200000, timeoutMs: 1_800_000 };
  return config;
};

const designPrompt = "Design telemetry for 1,200 greenhouse sensors reporting every 10 s (250 B per reading), keep 90 days, and keep the dashboard no more than 30 s behind.";
const telemetryDraft = [
  "## Ingest", "The 1,200 sensors report every 10 s, which is 120 readings per second. Each reading is 250 B, so ingest is 2.592 GB per day.",
  "## Retention", "Keeping 90 days needs about 233.28 GB of storage on the primary volume.",
  "## Freshness", "Readings are batched and flushed every 60 seconds. The dashboard is never more than 30 seconds behind.",
  "## Operations", "Each collector restarts cleanly, replays its local buffer and resumes from the last acknowledged offset. ".repeat(30).trim(),
].join("\n\n");
const confirmedFigures = [
  { claim: "120 readings per second", expression: "1200 / 10[s]", stated: 120, unit: "1/s" },
  { claim: "ingest is 2.592 GB per day", expression: "120 * 250[B/s] * 1[day]", stated: 2.592, unit: "GB" },
  { claim: "90 days needs about 233.28 GB", expression: "2.592[GB/day] * 90[days]", stated: 233.28, unit: "GB" },
];
const freshness = { requirement: "dashboard no more than 30 s behind", relation: "<=", limit: 30, unit: "s", achievedClaim: "flushed every 60 seconds" };
const draftCheck = JSON.stringify({ figures: confirmedFigures, targets: [{ ...freshness, expression: "60[s]" }],
  conflicts: [{ first: "flushed every 60 seconds", second: "The dashboard is never more than 30 seconds behind", why: "a 60 s flush cannot keep a 30 s freshness" }] });
const cleanCheck = JSON.stringify({ figures: confirmedFigures, targets: [{ ...freshness, expression: "10[s]", achievedClaim: "flushed every 10 seconds" }], conflicts: [] });

/** A provider that answers the draft, the figure checks and the audits from scripts. */
const scripted = (checkReplies: string[], auditReplies: string[], draft = telemetryDraft) => {
  const checks: string[] = [], audits: Array<Record<string, unknown>> = [], systems: string[] = [];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async (request: ProviderRequest) => {
    const system = request.messages[0]?.content ?? "";
    if (system.startsWith("Check the draft's arithmetic")) {
      checks.push(JSON.parse(request.messages[1].content).draft);
      return reply(checkReplies[Math.min(checks.length, checkReplies.length) - 1]);
    }
    if (/Internal consistency audit/.test(system)) {
      audits.push(JSON.parse(request.messages[1].content)); systems.push(system);
      return reply(auditReplies[Math.min(audits.length, auditReplies.length) - 1]);
    }
    return reply(draft);
  } };
  return { provider, checks, audits, systems };
};
const edits = (...list: Array<[string, string]>) => JSON.stringify({ edits: list.map(([find, replace]) => ({ find, replace, reason: "fix" })) });

test("a rewrite that changes a figure the calculator confirmed is refused and the draft kept", async t => {
  const rewrite = telemetryDraft.replace("233.28 GB", "466.56 GB").replace("flushed every 60 seconds", "flushed every 10 seconds");
  const script = scripted([draftCheck], [rewrite]);
  const { controller, events } = await fixture(t, script.provider, designConfig());
  assert.equal((await controller.interact(designPrompt)).content, telemetryDraft);
  const rejected = events.find(event => event.type === "consistency_answer_audit_rejected");
  assert.equal(rejected?.data.reason, "changed_confirmed_figures");
  assert.deepEqual(rejected?.data.confirmedFigures, [233.28]);
});

test("audit edits are applied one by one: an edit to a confirmed figure is refused, the fix is kept and the result re-checked", async t => {
  const script = scripted([draftCheck, cleanCheck], [edits(["about 233.28 GB", "about 466.56 GB"], ["flushed every 60 seconds", "flushed every 10 seconds"])]);
  const { controller, events } = await fixture(t, script.provider, designConfig());
  const answer = (await controller.interact(designPrompt)).content;
  assert.match(answer, /about 233\.28 GB/); assert.match(answer, /flushed every 10 seconds/);
  assert.match(answer, /## Operations/);
  const [packet] = script.audits;
  assert.deepEqual((packet.verifiedFigures as Array<{ stated: number }>).map(item => item.stated), [120, 2.592, 233.28]);
  assert.equal((packet.targetChecks as Array<{ achieved: number }>)[0].achieved, 60);
  assert.equal((packet.possibleContradictions as unknown[]).length, 1);
  assert.equal(packet.figureChecks, undefined, "no mismatch, no figure questions");
  assert.match(script.systems[0], /never proceed with an option that breaks an explicit requirement/);
  assert.equal(script.checks.length, 2, "the audited text was checked again");
  const audit = events.find(event => event.type === "consistency_answer_audit");
  assert.equal(audit?.data.mode, "edits"); assert.equal(audit?.data.refusedEdits, 1); assert.equal(audit?.data.rechecked, true);
});

test("an edit that the re-check finds wrong is undone and the other edits stay", async t => {
  const recheck = JSON.stringify({ figures: [...confirmedFigures, { claim: "with two replicas the total is 700 GB", expression: "233.28[GB] * 2", stated: 700, unit: "GB" }], targets: [], conflicts: [] });
  const script = scripted([draftCheck, recheck], [edits(["flushed every 60 seconds", "flushed every 10 seconds"],
    ["of storage on the primary volume.", "of storage on the primary volume. With two replicas the total is 700 GB."])]);
  const { controller, events } = await fixture(t, script.provider, designConfig());
  const answer = (await controller.interact(designPrompt)).content;
  assert.match(answer, /flushed every 10 seconds/);
  assert.doesNotMatch(answer, /700 GB/);
  assert.equal(events.find(event => event.type === "consistency_answer_audit")?.data.revertedEdits, 1);
});

test("a correct fix is kept although it makes the answer much longer", async t => {
  const addition = " To meet the 30 s target the collectors flush every 10 seconds instead, and a late batch raises an alert. " + "The alert names the collector, the batch and its age. ".repeat(80);
  const script = scripted([draftCheck, JSON.stringify({ figures: [], targets: [], conflicts: [] })], [edits(["Readings are batched and flushed every 60 seconds.", `Readings are batched and flushed every 10 seconds.${addition}`])]);
  const { controller, events } = await fixture(t, script.provider, designConfig());
  const answer = (await controller.interact(designPrompt)).content;
  assert.ok(answer.length > telemetryDraft.length * 1.5);
  assert.match(answer, /flushed every 10 seconds/);
  assert.equal(events.filter(event => event.type === "consistency_answer_audit_rejected").length, 0);
});

test("a second audit gets only what the re-check still finds, and the passes stay bounded", async t => {
  const partly = JSON.stringify({ figures: confirmedFigures, targets: [{ ...freshness, expression: "10[s]", achievedClaim: "flushed every 10 seconds" }],
    conflicts: [{ first: "flushed every 10 seconds", second: "The dashboard is never more than 30 seconds behind", why: "check" }] });
  const script = scripted([draftCheck, partly], [edits(["flushed every 60 seconds", "flushed every 10 seconds"]), JSON.stringify({ edits: [] })]);
  const { controller } = await fixture(t, script.provider, designConfig());
  assert.match((await controller.interact(designPrompt)).content, /flushed every 10 seconds/);
  assert.equal(script.audits.length, 2);
  assert.equal(script.audits[1].targetChecks, undefined);
  assert.equal((script.audits[1].possibleContradictions as unknown[]).length, 1);
  assert.match(String(script.audits[1].draft), /flushed every 10 seconds/);
  assert.equal(script.checks.length, 2, "an audit that changes nothing is not re-checked");
});

const researchConfig = () => {
  const config = structuredClone(base);
  config.interaction = { strategy: "adaptive", maxModelCalls: 10, maxTotalTokens: 200000 };
  return config;
};
const ferryDraft = ["Winter service", "Fares", "Northern crossing", "Southern crossing", "Caveats"].map((title, index) =>
  `## ${title}\nPart ${index + 1}: the operator's notice on ${title.toLowerCase()} sets out the changes for this winter ([operator notice](https://example.org/source)). ${"Each change is described with its start date and the routes it affects. ".repeat(5)}`).join("\n\n");
const research = async (t: test.TestContext, audit: ProviderResponse, draft = ferryDraft, ask = "Research this winter's ferry service changes.") => {
  t.mock.method(DocdexClient.prototype, "initialize", async () => ({ repoId: "fixture" }));
  t.mock.method(DocdexClient.prototype, "waitForIndex", async () => ({ num_docs: 1 }));
  t.mock.method(DocdexClient.prototype, "webResearch", async () => ({ web_context: [{ url: "https://example.org/source", content: "The winter timetable starts in November; the northern crossing keeps its sailings for a further three months." }] }));
  let calls = 0, system = "";
  const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls === 1) return { ...reply(""), toolCalls: [{ id: "web", name: "codali", args: { name: "docdex_web_research", args: { query: "winter ferry timetable" } } }] };
    if (calls === 2) return reply(draft);
    system = request.messages[0].content;
    return audit;
  } }, researchConfig(), { allowWeb: true }, true);
  const answer = (await controller.interact(ask)).content;
  return { answer, events, system: () => system };
};

test("a research audit rewrite cut off inside a link at an ordinary token count does not replace the draft", async t => {
  const cut = `${ferryDraft.slice(0, Math.floor(ferryDraft.length * 0.7)).replace(/\s*\S*$/u, "")} see the [archived timetable](https://web.archive`;
  const { answer, events, system } = await research(t, reply(cut, 377));
  assert.match(answer, /## Caveats/);
  assert.equal(events.find(event => event.type === "research_answer_audit_rejected")?.data.reason, "cut_off");
  assert.doesNotMatch(system(), /500 words/);
});

test("research audit edits correct one claim and keep every section of the draft", async t => {
  const { answer, events, system } = await research(t, reply(edits(["Part 3: the operator's notice on northern crossing", "Part 3: the operator's notice keeps the northern crossing's sailings for a further three months and"])));
  assert.match(answer, /for a further three months/);
  for (const title of ["Winter service", "Fares", "Northern crossing", "Southern crossing", "Caveats"]) assert.match(answer, new RegExp(`## ${title}`));
  assert.equal(events.find(event => event.type === "research_answer_audit")?.data.mode, "edits");
  assert.match(system(), /bounded selection/);
});

test("an edit list that does not parse is neither applied nor delivered as the answer", async t => {
  const { answer, events } = await research(t, reply('{"edits":[{"find":"Part 1","replace":"Part one"'));
  assert.equal(answer, ferryDraft);
  assert.equal(events.find(event => event.type === "research_answer_audit_rejected")?.data.reason, "invalid_edits");
});

test("restating a confirmed figure with rounding is not a change to it", async t => {
  const rewrite = telemetryDraft.replace("233.28 GB", "233.3 GB").replace("flushed every 60 seconds", "flushed every 10 seconds");
  const script = scripted([draftCheck, cleanCheck], [rewrite]);
  const { controller } = await fixture(t, script.provider, designConfig());
  assert.equal((await controller.interact(designPrompt)).content, rewrite);
});

// Review findings on the first version (fresh variants: a pallet-loading
// warehouse design and a library-hours research answer).
const palletPrompt = "Plan pallet loading for a cold store with 81 pallets per crew shift and $12 handling cost per pallet.";
const palletDraft = [
  "## Throughput", "We run 3 crews per day, each loading 81 pallets, so the dock loads 243 pallets per day.",
  "## Cost", "At $12 per pallet, handling costs $2,916 per day.",
  "## Schedule", "Dock slots start at 06:00, 10:00, 14:00 and 18:00, each lasting 45 minutes with a 15 minute changeover.",
  "## Operations", "Each crew checks the seal, the probe temperature and the load plan before the doors open. ".repeat(40).trim(),
].join("\n\n");
const palletFigures = [
  { claim: "the dock loads 243 pallets per day", expression: "3 * 81", stated: 243 },
  { claim: "handling costs $2,916 per day", expression: "243 * 12[$]", stated: 2916, unit: "$" },
];
const palletCheck = (figures = palletFigures) => JSON.stringify({ figures, targets: [], conflicts: [] });

test("an edit that changes an input of a confirmed figure frees that figure and what is built on it", async t => {
  const fourCrews = [{ claim: "the dock loads 324 pallets per day", expression: "4 * 81", stated: 324 }, { claim: "handling costs $3,888 per day", expression: "324 * 12[$]", stated: 3888, unit: "$" }];
  const script = scripted([palletCheck(), palletCheck(fourCrews)], [edits(["We run 3 crews per day", "We run 4 crews per day"],
    ["loads 243 pallets per day", "loads 324 pallets per day"], ["handling costs $2,916 per day", "handling costs $3,888 per day"])], palletDraft);
  const { controller, events } = await fixture(t, script.provider, designConfig());
  const answer = (await controller.interact(palletPrompt)).content;
  assert.match(answer, /4 crews/); assert.match(answer, /324 pallets/); assert.match(answer, /\$3,888/);
  assert.equal(events.find(event => event.type === "consistency_answer_audit")?.data.refusedEdits, 0);
});

test("an edit that changes an input but leaves its result is undone when the re-check finds them inconsistent", async t => {
  const stale = [{ claim: "the dock loads 243 pallets per day", expression: "4 * 81", stated: 243 }, palletFigures[1]];
  const script = scripted([palletCheck(), palletCheck(stale)], [edits(["We run 3 crews per day", "We run 4 crews per day"])], palletDraft);
  const { controller, events } = await fixture(t, script.provider, designConfig());
  const answer = (await controller.interact(palletPrompt)).content;
  assert.match(answer, /3 crews/);
  assert.equal(events.find(event => event.type === "consistency_answer_audit")?.data.revertedEdits, 1);
});

const libraryDraft = [
  "## Opening hours", `The central library opens 09:00-20:00 on weekdays from January ([city notice](https://example.org/source)). ${"Evening hours apply to the lending desk and the reading rooms alike. ".repeat(10).trim()}`,
  "## Background", "The library has a long history in the city and its reading rooms are well known. ".repeat(16).trim(),
  "## Branches", `Branch libraries keep their present hours ([city notice](https://example.org/source)). ${"Each branch posts its hours at the entrance and on its own page. ".repeat(10).trim()}`,
].join("\n\n");

test("one large legitimate deletion does not discard the other edits", async t => {
  const background = libraryDraft.split("\n\n")[3];
  const share = background.length / libraryDraft.length;
  assert.ok(share > 0.4 && share < 0.5, `the deleted passage is ${share} of the draft`);
  const { answer, events } = await research(t, reply(edits([background, "The library is the city's main public library."],
    ["opens 09:00-20:00 on weekdays", "opens 09:00-21:00 on weekdays"])), libraryDraft, "Research the library's new opening hours.");
  assert.match(answer, /09:00-21:00/); assert.match(answer, /main public library/); assert.match(answer, /## Branches/);
  assert.equal(events.find(event => event.type === "research_answer_audit")?.data.edits, 2);
});

test("a research audit respects the request's explicit length limit over the draft's length", async t => {
  const short = "## Opening hours\nThe central library opens 09:00-20:00 on weekdays from January ([city notice](https://example.org/source)).\n\n## Background\nIt is the main public library.\n\n## Branches\nBranches keep their present hours ([city notice](https://example.org/source)).";
  const { answer, system } = await research(t, reply(short), libraryDraft, "Research the library's new opening hours in at most 80 words.");
  assert.equal(answer, short);
  assert.match(system(), /at most 80 words/); assert.match(system(), /takes precedence/);
});
