# Changelog

## Unreleased

- Allow bounded Git diff/status inspection within the final validation budget;
  keep edits blocked and require actual test evidence before verifying code.
- Disable terminal echo before displaying the API-key prompt, preventing fast
  input from being echoed. Verify masked entry, backspace, cancellation, key
  rotation, logout, credential-cache refresh and bounded piped input.

## 0.1.135-codali.2 - 2026-10-26

- Keep core tool definitions available across task handoffs, while requiring a
  fresh task claim before execution. Record advertised tools for diagnosis.
- Explain stale verification with affected tasks and changed inputs so agents
  can revalidate existing work without replacing the plan.
- Preserve Windows workspace identity across short-path aliases and repair
  interrupted transcript tails. Retain mandatory file flushes on every platform.
- Resolve macOS Python native library dependencies within the shell sandbox,
  including Homebrew SSL libraries, without mounting broad installation roots.
- Internal validation prerelease for the `next` channel. Quality evaluation,
  consumer rollout and the 24-hour canary remain open promotion gates.

## 0.1.135-codali.1 - 2026-10-26

- Internal terminal CLI prerelease with mSwarm authentication, configuration-driven
  model roles and effort, durable goals and tasks, scoped permissions, asynchronous
  shell execution, session recovery, and interactive or JSONL operation.
- Add managed Docdex with verified runtime artifacts, pinned embedding identity,
  public embedding transport, memory persistence, and success/failure usage receipts.
- Add durable image, audio, and video jobs with artifact checksums and recovery.
- Preserve native Strata reasoning metadata and shared orchestration budgets;
  correct false worker-substitution diagnostics for embedded consumers.
- This tagged candidate was not published: platform qualification exposed
  macOS runtime and Windows persistence issues addressed in codali.2.

## 0.1.134 - 2026-10-25

- Forward final synthesis schemas and preserve OpenAI tool-call history.
- Merge prompt-only format constraints into the initial system message.
- Surface JSON error envelopes after HTTP 200 keepalives with bounded,
  credential-redacted diagnostics.
- Bound combined local worker tool results by UTF-8 bytes while preserving
  their audit records and truncation notices.

## Earlier changes

- Report the run's grounding mode on `CodaliResult`. An `open` run answers from
  the model and deliberately carries no sources, which a host could not tell
  apart from a search that found nothing: okacam's chat suppresses any answer
  that cites nothing, so it was refusing to return code it had been asked to
  write.
- Report every tool call the run made on `CodaliResult.toolCalls` - name,
  outcome and latency, without the model-generated arguments. Hosts previously
  had no way to record whether a question retrieved anything.
- Retrieve before asking a clarifying question, when there is something to
  retrieve. A tenant-scoped run holding the product's own connectors now plans
  and gathers evidence, and the classifier's question is put to the synthesizer
  with the evidence in front of it. A run with nothing but the code index still
  stops and asks. Measured cause: five of fifteen queries on okacam's
  2026-08-26 production smoke returned a question, having called no tool, for
  data other queries retrieved minutes later.
- Pin `@mcoda/db` and `@mcoda/shared` to concrete versions in the published
  manifest. 0.1.128 shipped `workspace:*` ranges, which npm rejects outside a
  workspace, so no consumer could install it; a published version cannot be
  replaced in place, so 0.1.129 is the fix.
- Initial public packaging for @mcoda/codali.
