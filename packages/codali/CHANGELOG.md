# Changelog

## Unreleased

## 0.1.135-codali.1 - 2026-10-26

- Internal terminal CLI prerelease with mSwarm authentication, configuration-driven
  model roles and effort, durable goals and tasks, scoped permissions, asynchronous
  shell execution, session recovery, and interactive or JSONL operation.
- Add managed Docdex with verified runtime artifacts, pinned embedding identity,
  public embedding transport, memory persistence, and success/failure usage receipts.
- Add durable image, audio, and video jobs with artifact checksums and recovery.
- Preserve native Strata reasoning metadata and shared orchestration budgets;
  correct false worker-substitution diagnostics for embedded consumers.
- Broad held-out evaluation, successful multi-hour journeys, helper comparisons,
  consumer rollout, and the 24-hour canary remain release gates. This prerelease
  is for internal validation and is published on the `next` channel.

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
