# Interaction routing investigation — 2026-10-28

Release is held. A real `hello` entered the execution loop: 14 lead calls,
four reviews, one embedding call, 119,088 tokens (117,189 input), and no final
answer. Review demanded an implementation artifact and the lead attempted a
`hello.txt` write. The user denied it. Increasing the budget cannot fix this.

## Primary evidence

- [Aider chat modes](https://aider.chat/docs/usage/modes.html) separate questions
  from changes; conversation can carry into later action. Its
  [AskCoder](https://github.com/Aider-AI/aider/blob/main/aider/coders/ask_coder.py)
  explicitly answers without edits. Architect/editor separation is useful for
  difficult changes, but adds calls and is unsuitable as a greeting workflow.
- [OpenCode agents](https://docs.opencode.ai/docs/agents/) separate capabilities,
  permissions, prompts and model choices. Its
  [configuration source](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/config.ts)
  describes `small_model` for tasks such as titles, not a universal user-intent
  router. We should not claim it supplies one.
- [Goose's current multi-model guide](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/multi-model/index.mdx)
  emphasizes model switching, focused subagents and context management. Its
  [older lead/worker article](https://github.com/aaif-goose/goose/blob/main/documentation/blog/2025-06-16-multi-model-in-goose/index.md)
  explicitly says that feature and its planning replacement were removed.
  Copying that obsolete workflow would be misleading.
- [RouteLLM](https://github.com/lm-sys/RouteLLM) demonstrates calibrated quality/cost
  routing. Its [controller](https://github.com/lm-sys/RouteLLM/blob/main/routellm/controller.py)
  routes on the last message and explicitly notes first-turn training. That is
  insufficient for `go ahead`, side questions, or the user's requested history
  awareness. Published savings do not establish results for our local models.

## Evaluation and decision criteria

Evaluate the existing entitled Qwen3 0.6B, 1.7B and 4B Instruct routes before
choosing the small model. The baseline measures structured-output validity,
semantic capability choice, answer correctness, context-dependent follow-ups,
actual token receipts and latency. Raw private request/response records are
under `~/.local/state/codali-intent-eval/`; no credentials belong in this report.

The architectural boundary is capability, not a catalog of phrases: an answer
without tools; bounded read-only investigation; or the existing authorized,
verified execution workflow. Missing intent should produce a clarification.
Routing and prompt preparation must happen before indexing, task creation and
review. A prepared brief supplements the verbatim request and bounded relevant
history; it never grants permission or replaces the user's constraints.

Configuration owns model bindings and versioned prompts. Invalid routing must
not silently start editing. Preserve existing execution verification and
uncertain-operation fences. Track session totals separately from bounded
interaction budgets. Every request needs a durable final answer or error record,
including cancellation and preflight failure, for later learning work.

Acceptance is live behavior across varied prompts plus regression tests, not
only a successful JSON parse or a lower model price. Model selection and final
measurements will be recorded here after evaluation.

## Measured result and selected workflow

Use the existing local Qwen3 4B Instruct route for semantic dispatch, with a
separate `intent` binding. Keep legacy automation's `router` binding unchanged.
The 0.6B and 1.7B models did not reliably follow the output/intent contract.
Reducing the decision to `mode` and `text`, clarifying missing context, and
bounding delegated briefs yielded 16/16 mode/schema checks with prompt v8.
This is a small evaluation corpus, not a general accuracy claim.

Do not use the small model to rewrite code: a live follow-up produced an invalid
`setTimeout` example. Code explanations and code-related follow-ups now go to
the stronger model without execution tools. A separate live sequence exercised
greetings, another language, arithmetic, explanations, follow-ups, file reading,
command explanation and careful reasoning. Its incorrect intermediate outputs
are retained in the private logs rather than erased from the evaluation.

The actual CLI's latest `hello` used **481 tokens, one call, no tools and 3.92s**;
it returned a friendly answer and exit code 0. It did not create a work goal.
The reported failure used 119,088 tokens and returned no answer. These are
individual measurements; shared service queuing makes latency variable.

The coding fixture initially hit its unchanged 64,000-token budget before
review completed. Its first lead request contained 3,638 characters of mostly
empty memory diagnostics and private index paths. Semantic memory projection
and shorter duplicate instructions let the same fixture complete with verified
work at 58,116 tokens. Its 11 generated tests and 1,681 independent cases passed;
the user's notes remained unchanged. This qualifies that fixture, not the
separate long-workflow release gates.

See [the evaluation record](codali-interaction-evaluation.json). Reproduce the
classification checks with `scripts/eval-codali-interactions.mjs --config PATH
--out NEW_PRIVATE_JSONL`. Review answer correctness separately from the script's
mode/schema score. Raw requests, outputs, errors and prior failures remain in
private session/evaluation logs for the future learning work.
