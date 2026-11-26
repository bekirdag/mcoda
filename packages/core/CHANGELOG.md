# Changelog

## 0.1.135-codali.45

- Ships with @mcoda/codali 0.1.135-codali.45 (no other changes in this package).

## 0.1.135-codali.43

- Ships with @mcoda/codali 0.1.135-codali.43 (no other changes in this package).

## 0.1.135-codali.42

- Ships with @mcoda/codali 0.1.135-codali.42 (no other changes in this package).

## 0.1.135-codali.41

- Ships with @mcoda/codali 0.1.135-codali.41 (no other changes in this package).

## 0.1.135-codali.40

- Initial public packaging for @mcoda/core.
- Add self-hosted mswarm client identity headers, query params, sync metadata,
  and node allowlist normalization to `MswarmApi`.
- Remove mswarm telemetry consent and data collection: drop
  `MswarmApi.issuePaidConsent`, `registerFreeMcodaClient`, `revokeConsent`,
  `requestDataDeletion`, `MSWARM_CONSENT_POLICY_VERSION`,
  `MCODA_FREE_CLIENT_TYPE` and the consent response types. `MswarmConfigStore`
  no longer reads or writes consent tokens, client ids or upload signing
  secrets; `clearLegacyConsentState()` removes those values left by older
  releases (local only).

## 0.1.132 - 2026-10-16

- Open the local agent repository on first catalog synchronization, allowing
  consent and remote mswarm requests to work with a read-only agent database.

## 0.1.78
- Add MswarmApi owner-local generic GPU job helpers for capability reads,
  artifact upload, run/status/logs/events/artifacts, cancellation, retry, and
  ops summaries.

## 0.1.9
- Release v0.1.9.

## 0.1.8
- Initial release.
