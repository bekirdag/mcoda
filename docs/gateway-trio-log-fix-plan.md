# Plan: Fix Gateway-Trio Issues from logs/1.txt

## Goals
- Eliminate prompt conflicts that lead to invalid outputs (gateway + work-on-tasks).
- Improve docdex context reliability for doc links.
- Make gateway-trio progress reporting accurate during retries.
- Escalate review agents on invalid JSON output.
- Reduce gateway hallucination risk by clarifying prompt behavior when evidence is missing.

## Plan
1. **Sanitize gateway prompt assembly**
   - Filter out job/character prompts that contain routing-only schema instructions (e.g., “routing gateway”, “route: devstral-local”).
   - Ensure only the gateway-agent schema prompt is used when building the gateway agent prompt.
   - Add a guard note in `prompts/gateway-agent.md` to state: docdex context is injected by mcoda and the agent must not claim to have executed docdex queries.

2. **Fix work-on-tasks prompt contradiction**
   - Remove the “Provide a concise plan…” line in `WorkOnTasksService.buildPrompt` to align with strict patch-only output requirements.
   - Keep the strict output requirements block as the single source of truth.

3. **Resolve docdex doc_links correctly**
   - In `WorkOnTasksService.gatherDocContext`, detect `docdex:` or `doc:` prefixed links and resolve via `DocdexClient.findDocumentByPath` first.
   - Fall back to `fetchDocumentById` only when the link looks like a real docdex id or when path lookup fails.
   - Log warnings when a doc link cannot be resolved.

4. **Improve gateway-trio progress reporting**
   - Increment `processedItems` after each task attempt (success or failure) rather than only on completion.
   - Keep `totalItems` as the number of tasks selected for the cycle.

5. **Escalate review agents on invalid JSON**
   - When a review response is still invalid JSON after retry, mark the task blocked with reason `review_invalid_output`.
   - Add `review_invalid_output` to retryable block reasons and escalation reasons so a stronger reviewer is selected next cycle.
   - Keep decision “block” but carry the error code to drive gateway escalation.

## Test Strategy
- **Unit tests**
  - GatewayAgentService: prompt sanitization excludes routing-only prompt content.
  - WorkOnTasksService: prompt no longer contains conflicting “plan” instruction; docdex link resolution uses `findDocumentByPath` for `docdex:` links.
  - GatewayTrioService: processedItems increments on failed attempts.
  - CodeReviewService: invalid JSON path marks `review_invalid_output` and yields escalation-friendly error.

- **Integration tests**
  - None required beyond existing service tests; verify via `pnpm -r run test` and `node tests/all.js`.

