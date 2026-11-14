# Progress

- Read ~/.codex/AGENTS.md and applied planning_progress_loop. Existing Codali catalog exactly matches all 107 tools and input schemas advertised by the system service.
- Found basic-only memory instructions and obsolete model:configured-docdex-helper override in the catalog delegation wrapper.
- Docdex symbols/impact returned empty results; inspected wrapper and callers directly. Changes are limited to instructions, wrapper delegation arguments and regression coverage.
- Verified system delegation enabled, enforced local, no primary/cloud fallback, both lanes pinned to the required mswarm agent. Successful Qwen delegation receipt: 16783a44-d1eb-4bc3-9d45-d8de8e7423d3. Reviewed the draft rather than adopting its overly narrow diary rule.
- Build and 30 focused tests passed (DocdexCatalog, DocdexTools and SkillCatalog); all four references included in npm pack dry-run. Tests include delegation override stripping and all native tool names documented.
- Live reads through Codali succeeded for profile, repo memory, conversations, diary, KG and personal-preference status; all six lanes report enabled. No settings changes needed.
- Actual fixed-wrapper delegation returned OK via qwen-latest-flash-next, receipt 7baf6e7f-7cf4-4e9b-a499-11763a622bd4. System config retained local enforcement and no fallback.
- Bounded Qwen behavior probe loaded docdex-research and both pages of the memory reference, mapped all six lanes correctly, explained discovery/disabled features and rejected memory writes for read-only requests. Four model calls, 10,326 tokens; raw evidence in docs/benchmarks/codali-docdex-coverage. Tool names in its explanatory answer used some shorthand; no Docdex execution was claimed. Clarified reference names afterward. This is development evidence, not a full intelligence benchmark.
- Updated local preview dist/config with rollback under ~/.local/state/codali-docdex-coverage-backups; verified installed skill and all reference pages. Restart Codali to load changes. No npm publication or global personal-memory settings changes.
- CLI-only host operations remain subject to actual host execution availability; no new shell/host privileges granted. All 107 native features are known/classified, but destructive maintenance was not executed for testing.
