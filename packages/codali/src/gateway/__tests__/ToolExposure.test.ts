import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EXPANDED_TOOLS,
  renderCapabilityLines,
  renderToolLines,
  type ToolExposureDescriptors,
} from "../ToolExposure.js";

const descriptors: ToolExposureDescriptors = {
  docdex_search: {
    name: "docdex_search",
    description: "Search the indexed repository.",
    capability: "docdex",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" }, limit: { type: "number" } },
    },
  },
  docdex_open: {
    name: "docdex_open",
    description: "Read an exact slice of a file.",
    capability: "docdex",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
  docdex_web_research: {
    name: "docdex_web_research",
    description: "Search the public web.",
    capability: "web",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
  },
  write_file: {
    name: "write_file",
    description: "Write content to a file.",
    capability: "workspace",
    readOnly: false,
  },
};

const allTools = Object.keys(descriptors);

test("capability lines summarize groups without leaking schemas", () => {
  const rendered = renderCapabilityLines(allTools, descriptors);
  assert.match(rendered, /- docdex — /);
  assert.match(rendered, /- web — /);
  assert.match(rendered, /2 tools/);
  assert.match(rendered, /1 tool\b/);
  // Stage 1 must stay cheap: no argument shapes at this level.
  assert.ok(!rendered.includes("args:"));
  assert.ok(!rendered.includes("query"));
});

test("tool lines expand descriptions and argument shapes", () => {
  const { text } = renderToolLines(allTools, descriptors);
  assert.match(text, /- docdex_search: Search the indexed repository\./);
  assert.match(text, /args: \{ query: string, limit\?: number \}/);
});

test("capability selection narrows which schemas are expanded", () => {
  const { text, expandedTools } = renderToolLines(allTools, descriptors, ["web"]);
  assert.deepEqual(expandedTools, ["docdex_web_research"]);
  assert.ok(!text.includes("docdex_search"));
  assert.ok(!text.includes("write_file"));
});

test("an unrecognized capability selection expands everything rather than blinding the planner", () => {
  const { expandedTools } = renderToolLines(allTools, descriptors, ["nonsense"]);
  assert.deepEqual(expandedTools.sort(), [...allTools].sort());
});

test("write tools are marked so the planner does not treat them as read-only", () => {
  const { text } = renderToolLines(allTools, descriptors, ["workspace"]);
  assert.match(text, /- write_file \[write\]:/);
});

test("a denied tool never appears in either exposure stage", () => {
  // The policy compiler is what removes denied tools; exposure only renders
  // what it is given. This asserts the contract that exposure never
  // reintroduces a name outside the allowed list.
  const allowed = allTools.filter((name) => name !== "write_file");
  const capabilities = renderCapabilityLines(allowed, descriptors);
  const { text } = renderToolLines(allowed, descriptors);
  assert.ok(!capabilities.includes("workspace"));
  assert.ok(!text.includes("write_file"));
});

test("expansion is capped so a large tenant catalog cannot blow the prompt", () => {
  const many: ToolExposureDescriptors = {};
  const names: string[] = [];
  for (let index = 0; index < MAX_EXPANDED_TOOLS + 10; index += 1) {
    const name = `mcp:bulk:tool_${index}`;
    names.push(name);
    many[name] = {
      name,
      description: `Bulk tool ${index}.`,
      capability: "bulk",
      readOnly: true,
    };
  }
  const { expandedTools, truncated } = renderToolLines(names, many);
  assert.equal(expandedTools.length, MAX_EXPANDED_TOOLS);
  assert.equal(truncated, true);
});

test("tools with no descriptor still render, defaulting to read-only general", () => {
  const { text } = renderToolLines(["mystery_tool"], undefined);
  assert.match(text, /- mystery_tool: read-only allowed tool/);
  const capabilities = renderCapabilityLines(["mystery_tool"], undefined);
  assert.match(capabilities, /- general — /);
});
