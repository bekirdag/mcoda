# Changelog

## Unreleased

## 0.1.105 - 2026-07-31

- Add a packaged loopback stable-diffusion.cpp image bridge that safely makes
  `negative_prompt`, `seed`, and `steps` effective, validates upstream model and
  PNG output consistency, rejects redirects, bounds slow-client concurrency,
  preserves the native inference lock after client timeouts, and documents a
  hardened service/registration rollout.
- Preserve finite positive fractional duration limits in generative-operation
  catalogs so verified frame rates can advertise exact video durations.

## 0.1.104 - 2026-07-31

- Serialize video-operation `defaultFps` as catalog `default_fps` across mcoda,
  agent setup, and mswarm so off-box duration validation matches the local Wan
  bridge's 16 FPS default.
- Keep Wan diffusion on GPU while moving VAE compute to CPU in the production
  service configuration to avoid decode-time GPU OOM on the shared RTX 3090.

## 0.1.103 - 2026-07-31

- Add first-class self-hosted video modality and `videos.generations` relay
  support, including operation-bound tokens, catalog limits, and canonical
  `b64_video` responses.
- Add a hardened Wan 2.2 stable-diffusion.cpp async-to-synchronous bridge,
  contract tests, and a pinned dual-RTX-3090 production runbook.

## 0.1.102 - 2026-07-31

- Refresh transitive security overrides for archive parsing, URI validation,
  request routing, YAML parsing, multipart handling, and brace expansion.
- Add image and audio operation metadata for self-hosted mswarm agents, including
  public/upstream model separation, bounded media relay, and operation-bound
  invocation tokens.
- Add a hardened `stable-diffusion-cpp` runner dialect so validated
  `seed`, `steps`, and `negative_prompt` controls work with `sd-server`.
- Add CLI registration flags, a production-oriented Stable Audio 3 TensorRT
  OpenAI-compatible wrapper, and an operations runbook for SD 3.5 and audio.

## 0.1.96 - 2026-07-18

- Preserve POSIX Homebrew paths while generating persistent daemon wrappers on
  cross-platform build and deployment hosts.

## 0.1.95 - 2026-07-18

- Keep persistent mSwarm node services running across Homebrew Node upgrades by
  storing the stable formula `opt` link instead of a versioned Cellar binary.

## 0.1.94 - 2026-07-16

- Generate GitHub release npm tarballs with pnpm so workspace dependencies are
  rewritten to portable package versions.
- Run Windows pnpm command shims through `ComSpec` so portable packaging works
  across every release matrix platform.
- Pin the OIDC publisher to Node-20-compatible npm `11.18.0` instead of the
  moving `npm@latest` target.
- Validate packed manifests and clean consumer installation before publishing.
- Refresh the Agent Setup SDK installation guide for the current release.

## 0.1.89 - 2026-07-02

- Add the product-neutral Codali agentic orchestration gateway with runtime
  policy compilation, dynamic tool contracts, mcoda agent-tier resolution,
  worker execution, evidence normalization, verification, context packing,
  final large-model synthesis, trace/replay, evaluations, and production
  safety boundaries.
- Expose the gateway through mswarm `codali_gateway` payloads while preserving
  existing `codali_job` and single-task runtime compatibility.
- Harden encrypted Docdex repository access and signed read-only app tool
  gateway dispatch for tenant-scoped product integrations.

## 0.1.88

- Add OSS docs, CI, release automation, and npm packaging metadata.
- Align mcoda SDK, agent setup SDK, and CLI self-hosted mswarm access with
  tenant/client identity headers, allowlist metadata, and catalog filtering.

## 0.1.78

- Add owner-local mswarm generic GPU/package job support across shared
  contracts, core APIs, CLI commands, SDK helpers, and docs.

## 0.1.9

- Release v0.1.9.

## 0.1.8

- Initial public release of the mcoda CLI.
