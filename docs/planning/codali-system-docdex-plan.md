# System-wide Docdex integration

1. Replace Codali session-owned daemon startup with a system-service client, explicit repository initialization, configurable endpoint and existing graceful local-tool fallback.
2. Preserve Docdex code/memory/web tool access using the service's configured model policy. Explain that service inference accounting is separate; do not launch private embedding bridges or silently change system model routing.
3. Change setup/doctor/docs to describe and probe the shared service rather than installing or requiring a private binary. Retain compatibility with old configuration fields without executing them.
4. Verify failed service startup/indexing fallback, repository isolation, sessions configured with embeddings never launching a daemon, and setup behavior. Run relevant build/tests and live shared-service checks.
5. Install locally, remove only verified orphan Codali-owned processes, preserve shared service/indexes/session data, commit/push; do not publish npm.
