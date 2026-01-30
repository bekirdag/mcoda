# Codali/Agent Talking Protocol (v1)

This protocol defines **deterministic, machine-readable** requests from remote agents to Codali, and the responses Codali sends back. It is required because agents are stateless and cannot access the repo or Docdex directly.

Codali must:
- Run requested Docdex/FS operations locally.
- Send full results back to the agent in a strict format.
- Always include recent context history in every request to the agent.

---

## 1) Envelope Types

### AGENT_REQUEST
```
AGENT_REQUEST v1
role: <librarian|architect|builder|critic|interpreter>
request_id: <uuid>
needs:
  - type: docdex.search
    query: "..."
    limit: 5
  - type: docdex.snippet
    doc_id: "..."
    window: 15
  - type: docdex.open
    path: "src/public/index.html"
    start_line: 1
    end_line: 200
  - type: docdex.impact
    file: "src/auth/login.ts"
  - type: docdex.web
    query: "..."
  - type: file.read
    path: "src/public/index.html"
  - type: file.list
    root: "."
    pattern: "**/*.html"
context:
  summary: "Need file contents to finalize plan"
  constraints:
    - "Only touch HTML"
```

### CODALI_RESPONSE
```
CODALI_RESPONSE v1
request_id: <uuid>
results:
  - type: docdex.search
    query: "auth login"
    hits: [...]
  - type: docdex.open
    path: "src/public/index.html"
    content: "..."
  - type: docdex.impact
    file: "src/auth/login.ts"
    inbound: [...]
    outbound: [...]
  - type: file.read
    path: "src/public/index.html"
    content: "..."
meta:
  repo_root: "/Users/.../repo"
  warnings:
    - "docdex_index_stale"
  elapsed_ms: 1234
```

---

## 2) Supported Request Types

### Docdex
- `docdex.search` (query, limit)
- `docdex.snippet` (doc_id, window)
- `docdex.open` (path/doc_id, start_line/end_line/window)
- `docdex.symbols` (file)
- `docdex.ast` (file)
- `docdex.impact` (file)
- `docdex.impact_diagnostics` (file, limit)
- `docdex.tree` (maxDepth)
- `docdex.web` (query, force_web)

### Filesystem
- `file.read` (path)
- `file.list` (root, pattern)

---

## 3) Response Rules

- Always return **all results** in a single `CODALI_RESPONSE`.
- For file content, include full content (unless budgeted), and note truncation.
- Include `meta.warnings` for any failures or skips.

### Critic Result (quality gate)
Critic output is carried back to the Architect as a protocol result:

```
CODALI_RESPONSE v1
request_id: critic-<ts>
results:
  - type: critic.result
    status: PASS|FAIL
    reasons:
      - "touched files outside allowed paths: ..."
    suggested_fixes:
      - "Address: touched files outside allowed paths: ..."
    touched_files:
      - "src/public/index.html"
    plan_targets:
      - "src/public/index.html"
meta:
  warnings:
    - "critic_failed"
```

Critic may also issue an `AGENT_REQUEST` for additional context (diffs, file reads, test output) before finalizing.

---

## 4) Context History Requirement

Codali must include the full **conversation history** in every agent call. If the prompt size approaches **90% of the agent’s context window**, Codali must:
1) Summarize history with a cheap summarizer agent.
2) Replace history with the summary + most recent messages.

---

## 5) Error Handling

If Codali cannot execute a request:
```
CODALI_RESPONSE v1
request_id: <uuid>
results: []
meta:
  warnings:
    - "docdex_search_failed"
    - "file_not_found: src/public/index.html"
```

---

## 6) Agent Guidance (Docdex Capabilities)

Agents should be told that Codali can run Docdex tools and that the canonical tool list is in:
`~/.docdex/agents.md`

Because agents cannot read this file directly, they must request Codali to fetch and summarize it when needed.

---

## 7) Example (Architect)

```
AGENT_REQUEST v1
role: architect
request_id: 123
needs:
  - type: docdex.search
    query: "landing page HTML"
    limit: 5
  - type: file.read
    path: "src/public/index.html"
context:
  summary: "Need root page HTML to finish plan"
```

Codali responds with file contents + search hits, then re-invokes the architect with updated context history.
