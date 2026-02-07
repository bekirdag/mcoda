import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentRequest, parseAgentRequest } from "../AgentProtocol.js";

test("parseAgentRequest parses JSON payload", () => {
  const input = JSON.stringify({
    request_id: "abc",
    role: "architect",
    needs: [{ type: "docdex.search", query: "auth login", limit: 3 }],
  });
  const parsed = parseAgentRequest(input);
  assert.equal(parsed.request_id, "abc");
  assert.equal(parsed.role, "architect");
  assert.equal(parsed.needs.length, 1);
  assert.equal(parsed.needs[0].type, "docdex.search");
});

test("parseAgentRequest parses protocol text", () => {
  const input = `AGENT_REQUEST v1
role: architect
request_id: req-1
needs:
  - type: docdex.search
    query: "login handler"
    limit: 5
  - type: file.read
    path: src/public/index.html
context:
  summary: Need root page HTML`;
  const parsed = parseAgentRequest(input);
  assert.equal(parsed.request_id, "req-1");
  assert.equal(parsed.needs.length, 2);
  assert.equal(parsed.needs[1].type, "file.read");
  assert.equal(parsed.context?.summary, "Need root page HTML");
});

test("parseAgentRequest rejects missing request_id", () => {
  assert.throws(() => parseAgentRequest("AGENT_REQUEST v1\nneeds:\n  - type: docdex.search\n    query: test"));
});

test("normalizeAgentRequest maps needs to tools", () => {
  const parsed = parseAgentRequest(`AGENT_REQUEST v1
role: architect
request_id: req-2
needs:
  - type: docdex.impact
    file: src/auth/login.ts`);
  const normalized = normalizeAgentRequest(parsed);
  assert.deepEqual(normalized, [{ tool: "docdex.impact", params: { file: "src/auth/login.ts" } }]);
});

test("parseAgentRequest supports file.list and file.diff", () => {
  const input = `AGENT_REQUEST v1
role: critic
request_id: req-3
needs:
  - type: file.list
    root: src
    pattern: "*.html"
  - type: file.diff
    paths: src/public/index.html, src/styles.css`;
  const parsed = parseAgentRequest(input);
  assert.equal(parsed.needs.length, 2);
  assert.equal(parsed.needs[0].type, "file.list");
  assert.equal(parsed.needs[1].type, "file.diff");
  const normalized = normalizeAgentRequest(parsed);
  assert.deepEqual(normalized, [
    { tool: "file.list", params: { root: "src", pattern: "*.html" } },
    { tool: "file.diff", params: { paths: ["src/public/index.html", "src/styles.css"] } },
  ]);
});

test("normalizeAgentRequest supports docdex.open and docdex.tree", () => {
  const input = `AGENT_REQUEST v1
role: architect
request_id: req-4
needs:
  - type: docdex.open
    path: src/app.ts
    start_line: 1
    end_line: 20
    clamp: true
  - type: docdex.tree
    path: .
    max_depth: 3
    dirs_only: true
    include_hidden: true`;
  const parsed = parseAgentRequest(input);
  const normalized = normalizeAgentRequest(parsed);
  assert.deepEqual(normalized, [
    {
      tool: "docdex.open",
      params: { path: "src/app.ts", start_line: 1, end_line: 20, head: undefined, clamp: true },
    },
    {
      tool: "docdex.tree",
      params: { path: ".", max_depth: 3, dirs_only: true, include_hidden: true },
    },
  ]);
});
