# Gateway Agent: How It Works

The gateway agent is mcoda’s **task interpreter**. It reads task context, docdex signals, and repository hints, and produces a **strict JSON plan** used to guide work‑on‑tasks and gateway‑trio routing.

## Role and responsibilities
- Summarize what’s requested and what’s already done.
- Identify **concrete file paths** and required directories.
- Produce a task plan with complexity and discipline labels.
- Avoid hallucinating repo structure.

## Core workflow
1. **Context assembly**
   - Task metadata (title, description, acceptance criteria).
   - Docdex snippets and doc links.
   - Project guidance (if available).
2. **Prompt construction**
   - Enforces JSON schema and required fields.
   - Prohibits placeholders (TBD, unknown, …).
   - Requires explicit `filesLikelyTouched`, `filesToCreate`, `dirsToCreate`.
3. **Agent invocation**
   - Streaming or sync.
   - Sanitizes `[agent-io]` markers.
4. **Normalization + validation**
   - Removes placeholder paths.
   - Splits dir markers from file paths.
   - Rejects routing‑only prompt contamination.

## JSON schema (simplified)
```
{
  "summary": "...",
  "reasoningSummary": "...",
  "currentState": "...",
  "todo": "...",
  "understanding": "...",
  "plan": ["..."],
  "complexity": 1-10,
  "discipline": "backend|frontend|uiux|docs|architecture|qa|planning|ops|other",
  "filesLikelyTouched": ["path/to/file"],
  "filesToCreate": ["path/to/new"],
  "dirsToCreate": ["path/to/dir"],
  "assumptions": ["..."],
  "risks": ["..."],
  "docdexNotes": ["..."]
}
```

## Guardrails
- **No placeholders**: `(unknown)`, `TBD`, `...`, globbing, `<...>` are stripped.
- **File list justification**: empty file lists require docdexNotes/assumptions explaining missing context.
- **Prompt sanitization**: routing‑only prompts are stripped before use.
- **No tool claims**: gateway must not claim it read files unless file content is provided.

## Why this design
- Gateway output feeds downstream WOT and GT; wrong file paths cause wasted cycles.
- JSON schema makes it machine‑actionable and auditable.
- Normalization avoids directory/file confusion and prevents hallucinated repo paths.

## Related code
- `packages/core/src/services/agents/GatewayAgentService.ts`
- `packages/core/src/services/agents/GatewayHandoff.ts`

