# Docker and Compose host access

Use a discovered authorized Docker connector and the actual Docker context. Inspect project/service labels and compose files before choosing a target. Limit status/log requests to that project. Do not dump container environments, unrelated containers or credentials.

Reuse the project's existing Compose or deployment definition. Service dependencies being started does not mean they are ready; use actual healthchecks and, when appropriate, dependency conditions such as service_healthy. Check both container state and the application endpoint.

For an authorized repair, preserve images/configuration needed for rollback and change only the intended service. Avoid global cleanup, volume deletion and unrelated daemon restarts. Verify persistence in a subsequent call and confirm which ports are bound to loopback versus externally reachable.

Codali's browser_session owns only its isolated desktop/static preview. It does not run arbitrary backend applications. Its generated container can be managed with browser_session status/stop.

Source: https://docs.docker.com/compose/how-tos/startup-order/
