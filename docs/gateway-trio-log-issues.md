# Gateway Trio Log Issues (logs/1.txt)

## Summary
Observed failures during a gateway-trio run on <PROJECT_KEY>. The issues below are derived from `<LOG_PATH>`.

## Issues
1. **Conflicting gateway prompt schemas**
   - The gateway agent prompt contains a routing-only JSON schema (complexity/route/rationale) *and* the full gateway-agent schema, causing contradictory instructions.
   - Impact: gateway agent output reliability drops and can violate schema expectations.

2. **Work-on-tasks prompt contradiction leads to missing patches**
   - Prompt says "Provide a concise plan" but later demands "Return only code changes".
   - Impact: work agents respond with prose/plan instead of patch/file blocks; task fails with `missing_patch`.

3. **Docdex doc_links with `docdex:` prefix resolve to null content**
   - `docdex:docs/sds/<PROJECT_SDS_DOC>.md` links are fed to `fetchDocumentById`, which returns `{"doc":null,"snippet":null}`.
   - Impact: agent context loses critical docs; doc summary is empty or misleading.

4. **Gateway-trio progress appears stalled (0/59)**
   - `processedItems` only increments on completion; failed/retried tasks do not update progress.
   - Impact: `--watch` shows no progress despite active work, looks like a hang.

5. **Code-review invalid JSON output is not escalated**
   - Review agent returns non-JSON after retry; system blocks review but does not tag a distinct failure reason to drive agent escalation.
   - Impact: gateway-trio can keep selecting the same failing reviewer; repeated invalid outputs.

6. **Gateway agent claims file-specific state without evidence**
   - Gateway response states specific migration paths and schema details even though docdex context didn’t include those files.
   - Impact: hallucinated currentState/plan details lead to wrong handoff.

