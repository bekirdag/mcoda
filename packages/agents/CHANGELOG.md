# Changelog

## Unreleased
- Accept every reasoning effort codex-cli accepts
  (`minimal|low|medium|high|xhigh|max|ultra`) instead of only
  `low|medium|high|xhigh`, so `max` and `ultra` reach
  `-c model_reasoning_effort=...` instead of being dropped for the model
  default. The gpt-5.1 ceiling now caps anything above `high` rather than only
  `xhigh`, and an effort outside the enum is reported on stderr instead of
  being ignored silently. The report names the effort the run falls back to,
  which is the `high` cap on gpt-5.1 and the model default elsewhere.

## 0.1.75
- Forward per-agent Codex CLI `reasoningEffort` configuration into `codex exec` so agents such as `codex55` can use `model_reasoning_effort=xhigh` without relying on process-wide environment variables.

## 0.1.9
- Release v0.1.9.

## 0.1.8
- Initial release.
