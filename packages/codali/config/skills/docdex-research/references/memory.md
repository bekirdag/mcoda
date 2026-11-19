# Six memory lanes

Use docdex_memory_layers for current scope/storage details and docdex_memory_route with the task when choosing a lane. These are complementary lanes, not six mandatory calls per turn. Host-bound repository and codali-terminal identity must not be replaced with another repo/agent or a global conversation namespace.

| Lane | Read when | Write when |
| --- | --- | --- |
| Repository facts | docdex_memory_recall for architecture, code locations, decisions and caveats; verify against current files | docdex_memory_save (or docdex_memory_store) for concise verified discoveries after meaningful work; include paths and evidence |
| Agent profile | docdex_get_profile early in substantial work for preferences and constraints | docdex_save_preference immediately for explicit corrections/preferences when permitted; not technical repo facts |
| Conversation archive | docdex_conversation_search, docdex_conversation_list, docdex_conversation_read, docdex_conversation_export for earlier requests and decisions; docdex_wakeup for a compact continuity bundle | docdex_conversation_import for selected authorized transcripts; docdex_conversation_hook for bounded milestone/compaction/session summaries |
| Diary | docdex_diary_read for progress, handoffs, blockers and next actions | docdex_diary_write for concise observed outcomes and unfinished work; distinguish unverified proposals |
| Temporal knowledge graph | docdex_kg_query, docdex_kg_search_nodes, docdex_kg_search_edges, docdex_kg_timeline, docdex_kg_neighborhood, docdex_kg_entity_links, docdex_kg_search_episodes, docdex_kg_episode for relationships, dates and provenance | Usually derived from conversation processing; use authorized rebuild/maintenance tools, not invented graph-write APIs |
| Personal preferences | docdex_personal_preferences_status first; docdex_personal_preferences_search/list/read/claims/claim_read and docdex_personal_preferences_routines (expand each suffix to its full catalog name) and docdex_clone_context/docdex_clone_directive for richer user-specific context | Feedback/operator-event tools or explicit claim review workflows when permitted; never automatically collect unrelated personal data |

Before complex personalized planning, inspect docdex_clone_directive and relevant routine evidence. Current user instructions and repo facts outrank inferred routines. Do not invent new approval requirements when the user has already authorized the work. Compare completed work with applicable required steps before reporting completion.

For continuity: docdex_wakeup, then selectively docdex_conversation_search and docdex_conversation_read or docdex_diary_read; use KG episode/timeline evidence when timing or provenance matters. Do not replay entire archives. A missing memory is not proof an event never happened.

For capture: save 1–3 sentence verified repo facts at milestones; save user corrections in profile; record unfinished work in diary. For supported memory supersession, include metadata.supersedes with prior IDs using a schema that advertises metadata. Do not invent adapter fields. Use docdex_conversation_hook actions periodic_memory_save, pre_compaction_summarization or session_close_summarization only as advertised. Review returned status; failed saves are not persisted memories.

Read-only investigations cannot perform memory writes. Never store secrets. Do not ingest raw logs/transcripts without checking scope and sensitive content. Profile memory is independent of repository memory enablement; report profile persistence failures. Disabled personal preferences are an unavailable feature, not permission to turn on global capture.

Redaction/deletion/pruning, KG clear/delete/rebuild, claim overrides/forgetting, retention changes and personal-data purge are maintenance actions requiring applicable authorization. Prefer supported previews/dry runs. Read/export after redaction may retain redacted placeholders. Do not remove evidence simply because it contradicts a current hypothesis.
