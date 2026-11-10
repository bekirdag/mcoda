import test from "node:test";
import assert from "node:assert/strict";

test("required input can borrow unused output allowance without changing input", () => {
  const request: ProviderRequest = { messages: [{ role: "user", content: "input ".repeat(1200) }], maxTokens: 2048 };
  const result = compressProviderContext(request, 4096, 2048);
  assert.deepEqual(result.request.messages, request.messages);
  assert.ok(result.request.maxTokens! >= 128 && result.request.maxTokens! < 2048);
  assert.ok(result.afterTokens + result.request.maxTokens! + 512 <= 4096);
  assert.equal(request.maxTokens, 2048);
});
import { compressConversation, compressExecutionHistory, compressProviderContext, contextHash, estimateContextTokens, executionHistoryBudget, fitOutputBudget, resultStillVisible } from "../ContextCompression.js";
import type { ProviderMessage, ProviderRequest } from "../../providers/ProviderTypes.js";

test("history indices stay bounded and retrievable across long sessions", () => {
  const history = (offset: number): ProviderMessage[] => Array.from({ length: 500 }, (_, index) => ({ role: "assistant", name: "completed_tool_history",
    content: JSON.stringify({ sha256: String(index + offset).padStart(64, "0"), tools: ["read_file"], results: ["retrieved source".repeat(10)] }) }));
  const pending: ProviderMessage = { role: "assistant", content: "", toolCalls: [{ id: "pending", name: "read_file", args: { path: "current.ts" } }] };
  const recent: ProviderMessage[] = [{ role: "user", content: "Keep the original requirements" }, { role: "assistant", content: "Recent evidence" }, pending];
  const first = compressProviderContext({ messages: [{ role: "system", content: "Never deploy" }, ...history(0), ...recent] }, 16000, 4096);
  assert.ok(first.afterTokens < 11000);
  assert.deepEqual(first.request.messages.slice(-3), recent);
  const index = first.request.messages.find(message => message.name === "context_history_index")!;
  assert.ok(index);
  const source = first.archived.find(entry => entry.sha256 === JSON.parse(index.content).sha256)!;
  assert.equal(contextHash(source.message), source.sha256);
  assert.ok(JSON.parse(source.message.content).length > 400);
  const second = compressProviderContext({ messages: [...first.request.messages.slice(0, -3), ...history(500), ...recent] }, 16000, 4096);
  assert.ok(second.afterTokens < 11000);
  assert.deepEqual(second.request.messages.slice(-3), recent);
  assert.ok(second.archived.some(entry => entry.message.content.includes(source.sha256)));
});

test("remaining budget admits a useful smaller response without raising ceilings", () => {
  const request: ProviderRequest = { messages: [{ role: "user", content: "Summarize the verified findings" }], maxTokens: 40960 };
  const input = estimateContextTokens(request);
  const affordable = fitOutputBudget(request, input + 2000, 40960);
  assert.equal(affordable.maxTokens, 2000);
  assert.equal(affordable.messages, request.messages);
  assert.equal(request.maxTokens, 40960);
  assert.equal(fitOutputBudget(request, 100000, 1024).maxTokens, 1024);
  assert.equal(fitOutputBudget({ ...request, maxTokens: 256 }, input + 2000, 40960).maxTokens, 256);
  assert.equal(fitOutputBudget(request, input + 127, 40960).maxTokens, 40960);
});

test("execution compaction preserves retrievable old findings and complete recent native groups", () => {
  const messages: ProviderMessage[] = [{ role: "user", content: "Keep all original requirements." }];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: `read-${i}`, name: "read_file", args: { path: `file-${i}.txt` } }] },
      { role: "tool", toolCallId: `read-${i}`, name: "read_file", content: `finding-${i}: ` + "source".repeat(1000) });
  }
  const original = structuredClone(messages);
  const compact = compressExecutionHistory(messages);
  assert.deepEqual(messages, original);
  const omittedCount = original.filter(m=>m.role === "tool").length - compact.messages.filter(m=>m.role === "tool").length;
  assert.ok(omittedCount > 0 && omittedCount < 20);
  assert.equal(compact.archived.length, omittedCount + 1);
  assert.match(compact.messages[0].content, new RegExp(`finding-${omittedCount - 1}`));
  assert.equal(JSON.parse(compact.messages[0].content).sha256, compact.archived[0].sha256);
  assert.equal(contextHash(compact.archived[0].message), compact.archived[0].sha256);
  const firstFinding = JSON.parse(compact.messages[0].content).activity[0];
  assert.ok(messages.some(message => message.content === compact.archived.find(entry=>entry.sha256 === firstFinding.sha256)!.message.content));
  const restored: ProviderMessage[] = JSON.parse(compact.archived[0].message.content);
  assert.deepEqual(restored.filter(m=>m.role === "tool"), original.filter(m=>m.role === "tool").slice(0, omittedCount));
  assert.deepEqual(compact.messages.filter(m=>m.role === "user"), original.filter(m=>m.role === "user"));
  const ids = compact.messages.flatMap(m=>m.toolCalls?.map(call=>call.id) ?? []);
  assert.deepEqual(compact.messages.filter(m=>m.role === "tool").map(m=>m.toolCallId), ids);
  assert.deepEqual(compressExecutionHistory(compact.messages), { messages: compact.messages, archived: [] });
  const continued = compressExecutionHistory([...compact.messages,
    { role: "assistant", content: "New finding".repeat(3000) }, { role: "assistant", content: "Next finding" }]);
  assert.equal(continued.messages.filter(m=>m.name === "execution_history").length, 1);
  assert.match(continued.archived[0].message.content, new RegExp(compact.archived[0].sha256));
});

test("conversation compression retains every user constraint and recoverable original replies", () => {
  const messages: ProviderMessage[] = [
    { role: "user", content: "Never deploy. Keep PostgreSQL and use milliseconds." },
    { role: "assistant", content: "Initial reply. " + "background explanation ".repeat(600) + " Pending decision: choose the cache TTL." },
    { role: "user", content: "The TTL is 1700 ms. Preserve the audit log." },
    { role: "assistant", content: "Recorded." },
  ];
  const before = structuredClone(messages), result = compressConversation(messages, 2000);
  assert.deepEqual(messages, before);
  assert.deepEqual(result.messages.filter(message => message.role === "user"), messages.filter(message => message.role === "user"));
  assert.ok(JSON.stringify(result.messages).length < 2500);
  assert.match(result.messages[1].content, /abbreviated.*Full saved source/);
  assert.match(result.messages[1].content, /Pending decision/);
  assert.deepEqual(result.archived[0].message, messages[1]); assert.equal(result.archived[0].sha256, contextHash(messages[1]));
  const repeated = compressConversation(result.messages, 2000); assert.equal(repeated.archived.length, 0);
});

test("identical observations are archived without dropping fresh source, errors or native pairs", () => {
  const pair = (id: string, content: string, name = "read_file"): ProviderMessage[] => [
    { role: "assistant", content: "", toolCalls: [{ id, name, args: { path: "server.js" } }] },
    { role: "tool", name, toolCallId: id, content },
  ];
  const source = "export const port = 0;".repeat(400);
  const messages: ProviderMessage[] = [{ role: "user", content: "Do not remove authentication." },
    ...pair("old", source), ...pair("changed", "new implementation"), ...pair("fresh", source),
    ...pair("error1", "ERROR denied"), ...pair("error2", "ERROR denied"),
    ...pair("write1", "written", "write_file"), ...pair("write2", "written", "write_file")];
  const copy = structuredClone(messages);
  const result = compressExecutionHistory(messages, 30000);
  assert.deepEqual(messages, copy);
  assert.deepEqual(result.messages.filter(m => m.role === "tool").map(m => m.toolCallId), ["changed", "fresh", "error1", "error2", "write1", "write2"]);
  assert.equal(result.messages.find(m => m.toolCallId === "fresh")?.content, source);
  assert.ok(result.archived.some(entry => entry.message.content === source));
  assert.deepEqual(result.messages.filter(m => m.role === "user"), [messages[0]]);
  assert.deepEqual(result.messages.flatMap(m => m.toolCalls?.map(c => c.id) ?? []), result.messages.filter(m => m.role === "tool").map(m => m.toolCallId));
});

test("context compaction counts schemas and output reserve and preserves native tool pairs", () => {
  const request: ProviderRequest = { messages: [
    { role: "system", content: "Goal: inspect only. Constraints: do not change files. Decision: PostgreSQL. Pending: validate retry delay." },
    { role: "user", content: "Show the retry delay from the actual repository." },
    { role: "assistant", content: "", toolCalls: [{ id: "call-7", name: "docdex_open", args: { path: "src/retry.ts" } }] },
    { role: "tool", toolCallId: "call-7", content: 'src/retry.ts:1 retryMs = 1700;\n' + "irrelevant source context ".repeat(1500) + "\nSource ends here." },
    { role: "assistant", content: "The retrieved value is 1700 ms." },
  ], tools: [{ name: "docdex_open", description: "Read source. ".repeat(100), inputSchema: { type: "object", properties: { path: { type: "string" } } } }], maxTokens: 512 };
  const before = structuredClone(request), result = compressProviderContext(request, 6000, 512);
  assert.ok(result.beforeTokens > 6000); assert.ok(result.afterTokens + 512 + 512 <= 6000);
  assert.deepEqual(result.request.messages.slice(0, 3), request.messages.slice(0, 3));
  assert.equal(result.request.messages[3].toolCallId, "call-7"); assert.equal(result.request.messages[3].role, "tool");
  assert.match(result.request.messages[3].content, /retryMs = 1700/); assert.match(result.request.messages[3].content, /Source ends here/);
  assert.deepEqual(result.request.tools, request.tools); assert.deepEqual(request, before);
  assert.equal(result.archived.length, 1); assert.equal(result.archived[0].message.content, request.messages[3].content);
  assert.equal(estimateContextTokens(result.request), result.afterTokens);
});

test("oversized fixed instructions fail before dispatch rather than discarding user constraints", () => {
  const request: ProviderRequest = { messages: [{ role: "system", content: "required rule ".repeat(1000) }, { role: "user", content: "Do not delete anything." }], maxTokens: 512 };
  assert.throws(() => compressProviderContext(request, 2048, 512), /no model call was sent/);
  assert.throws(() => compressProviderContext({ messages: [{ role: "user", content: "x".repeat(9000) }] }, 2048, 512), /User instructions/);
});

test("short requests are untouched and compaction spends no extra model calls", () => {
  const request: ProviderRequest = { messages: [{ role: "user", content: "Hello." }], maxTokens: 256 };
  const result = compressProviderContext(request, 4096, 256);
  assert.equal(result.request, request); assert.equal(result.archived.length, 0); assert.equal(result.beforeTokens, result.afterTokens);
});

test("recent recovered excerpts survive compaction of older history", () => {
  const fresh = "EXACT RECOVERED FUNCTION\n" + "code ".repeat(600);
  const request: ProviderRequest = { messages: [
    { role: "system", content: "Preserve user constraints." },
    { role: "user", content: "Implement the project." },
    { role: "tool", toolCallId: "old", content: "old context ".repeat(3000) },
    { role: "assistant", content: "I need the exact function." },
    { role: "tool", toolCallId: "other", content: "short" },
    { role: "assistant", content: "", toolCalls: [{ id: "recover", name: "context_read", args: { sha256: "saved" } }] },
    { role: "tool", toolCallId: "recover", content: fresh },
  ] };
  const result = compressProviderContext(request, 3500, 512);
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.equal(result.request.messages.at(-1)?.content, fresh);
  assert.ok(result.afterTokens + 1024 <= 3500);
  assert.ok(result.archived.every(entry => entry.message.content !== fresh));
});


test("execution history keeps many short tool groups while they fit the token budget", () => {
  const messages: ProviderMessage[] = [{role:"user",content:"Preserve the original architecture."}];
  for(let i=0;i<17;i++) messages.push(
    {role:"assistant",content:"",toolCalls:[{id:`call-${i}`,name:"read_file",args:{path:`module-${i}.js`}}]},
    {role:"tool",toolCallId:`call-${i}`,content:`export const value${i} = ${i};`});
  assert.deepEqual(compressExecutionHistory(messages),{messages,archived:[]});
  const compact=compressExecutionHistory(messages,300);
  assert.ok(compact.archived.length>0);
  assert.deepEqual(compact.messages.filter(m=>m.role==="user"),messages.filter(m=>m.role==="user"));
  const calls=compact.messages.flatMap(m=>m.toolCalls?.map(call=>call.id)??[]);
  assert.deepEqual(compact.messages.filter(m=>m.role==="tool").map(m=>m.toolCallId),calls);
  assert.equal(calls.at(-1),"call-16");
  assert.deepEqual(compressExecutionHistory(compact.messages,300),{messages:compact.messages,archived:[]});
});

test("provider compression archives completed large write arguments without orphaning calls", () => {
  const request: ProviderRequest = { messages: [
    { role: "system", content: "Never deploy" }, { role: "user", content: "Implement the project" },
    { role: "assistant", content: "", toolCalls: [{ id: "write", name: "write_file", args: { path: "app.ts", content: "code".repeat(20000) } }] },
    { role: "tool", toolCallId: "write", content: "File saved successfully" },
    { role: "user", content: "Continue and run tests" },
  ] };
  const original = structuredClone(request);
  const result = compressProviderContext(request, 16000, 4096);
  assert.deepEqual(request, original);
  assert.ok(result.afterTokens < 11000);
  assert.deepEqual(result.request.messages.filter(m => m.role === "user" || m.role === "system"), request.messages.filter(m => m.role === "user" || m.role === "system"));
  assert.equal(result.request.messages.some(m => m.toolCallId === "write" || m.toolCalls?.some(c => c.id === "write")), false);
  assert.ok(result.archived.some(entry => entry.message.content.includes('"path":"app.ts"')));
});

test("a large output ceiling does not starve evidence, and generation is clamped to what fits", () => {
  const evidence = Array.from({ length: 16 }, (_, index): ProviderMessage[] => [
    { role: "assistant", content: "", toolCalls: [{ id: `c${index}`, name: "browser_read", args: { snapshotId: `snap-${index}` } }] },
    { role: "tool", name: "browser_read", toolCallId: `c${index}`, content: `finding ${index} ` + "x".repeat(9000) }]).flat();
  const request: ProviderRequest = { messages: [{ role: "user", content: "Research this." }, ...evidence], maxTokens: 40960 };
  const result = compressProviderContext(request, 65536, 40960);
  assert.ok(result.afterTokens > 24000, `kept ${result.afterTokens} tokens of evidence`);
  assert.ok(result.afterTokens + result.request.maxTokens! + 512 <= 65536);
  assert.ok(result.request.maxTokens! >= 19000);
  const small: ProviderRequest = { messages: [{ role: "user", content: "y".repeat(90000) }], maxTokens: 40960 };
  const clamped = compressProviderContext(small, 65536, 40960);
  assert.ok(clamped.afterTokens + clamped.request.maxTokens! + 512 <= 65536, "an uncompressed request also fits the window");
});

test("folding keeps recent markers and a readable inventory of what already ran", () => {
  const markers: ProviderMessage[] = Array.from({ length: 400 }, (_, index) => ({ role: "assistant", name: "completed_tool_history", content: JSON.stringify({ sha256: `s${index}`, tools: ["browser_open"], results: [`opened page ${index} ` + "z".repeat(200)] }) }));
  const result = compressProviderContext({ messages: [{ role: "user", content: "Go." }, ...markers, { role: "user", content: "Continue." }], maxTokens: 1024 }, 16384, 1024);
  const index = result.request.messages.find(message => message.name === "context_history_index")!;
  const parsed = JSON.parse(index.content) as { inventory: Array<{ result: string }>; sha256: string };
  assert.ok(parsed.inventory.length > 0 && parsed.inventory.length <= 40);
  assert.match(parsed.inventory.at(-1)!.result, /opened page/);
  assert.ok(result.archived.some(entry => entry.sha256 === parsed.sha256));
  assert.ok(result.request.messages.filter(message => message.name === "completed_tool_history").length >= 8, "recent markers remain individually visible");
});

test("execution history keeps a usable share of a window with a large output ceiling", () => {
  // 65k window with a 40k output ceiling used to leave 6k tokens of history.
  assert.equal(executionHistoryBudget(65536, 40960), Math.floor((65536 - Math.floor(65536 * 0.3)) / 4));
  assert.equal(executionHistoryBudget(32768, 2048), (32768 - 2048) / 4);
});

test("an abbreviated or evicted tool result is not still visible", () => {
  const output = "source line\n".repeat(400);
  assert.equal(resultStillVisible(output, [output]), true);
  assert.equal(resultStillVisible(output, [`${output}\n\n[Tool metadata: invocation receipt ID x; receiptRef=y]`]), true);
  assert.equal(resultStillVisible(output, []), false);
  assert.equal(resultStillVisible(output, [`[Earlier tool content abbreviated. Full saved source: abc]\n${output.slice(0, 1000)}`]), false);
  assert.equal(resultStillVisible("", [""]), false);
});
