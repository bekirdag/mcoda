# Codali core skills expansion

Scope: add eight default skills for architecture-design, code-implementation, code-review, testing-and-verification, tool-selection, system-services system-diagnostics and ui-ux-design. Preserve six existing skills. No npm publication, no live service mutations or new host-access permissions.

1. Inspect skill catalog, actual tool schemas and host/sandbox capabilities; research primary workflow sources. Separate instructions from executable capabilities.
2. Write concise original adaptations with provenance. Keep each entrypoint small enough for one normal skill_load; use platform-specific references only where necessary. Services must discover an advertised authorized host connector, reuse browser_session for its supported purpose, and report missing general host access accurately.
3. Fix catalog discovery so new skills beyond the first four are visible within a bounded metadata budget. Keep bodies lazy, IDs unambiguous, source hashes and permission gates unchanged.
4. Validate YAML, references, metadata size, complete paginated discovery/loading and actual model skill selection/behavior for all eight areas. Use disposable fixtures, required mswarm local delegation and real Codali tool reads; no live service changes. Adjust only demonstrated failures.
5. Build, run relevant regression tests and package inspection, update the local preview with rollback backup, verify installed catalog, commit/push branch and record evidence.

Acceptance: 14 bundled skills available; all eight readable through actual skill tools; bounded catalog prompt; tests prove permissions unchanged and references load; recorded Qwen behavior identifies architecture/review/test issues and service-access limits. No claim that adding a skill grants general system-service access.

User steering added UI/UX design: include brand-aware visual direction, user flows, responsive/accessibility states and honest rendered/visual validation. Add a design-only behavior probe; do not claim screenshots were reviewed when no image tool was available.
