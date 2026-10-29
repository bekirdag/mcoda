import { readFileSync } from "node:fs";
import type { ToolInputSchema } from "../tools/ToolTypes.js";

export interface DocdexCatalogEntry { name: string; description: string; inputSchema: ToolInputSchema; }
// Versioned protocol snapshot enables lazy startup and zero catalog tokens on
// ordinary chat. A server's advertised schema is checked before first use.
export const docdexCatalog = (JSON.parse(readFileSync(new URL("../../config/docdex-tools-0.2.99.json", import.meta.url), "utf8")) as { tools: DocdexCatalogEntry[] }).tools;
const readNames = new Set(`search capabilities rerank batch_search files open tree stats repo_inspect symbols ast impact_diagnostics impact_graph dag_export
memory_recall conversation_search conversation_list conversation_read conversation_export diary_read wakeup kg_query kg_search_nodes kg_search_edges kg_timeline kg_search_episodes kg_neighborhood kg_entity_links kg_episode
llm_diagnostics personal_preferences_status personal_preferences_categories personal_preferences_retention_policies personal_preferences_list personal_preferences_read personal_preferences_search personal_preferences_reviews personal_preferences_export personal_preferences_claims personal_preferences_claim_read personal_preferences_operator_events personal_preferences_snapshots personal_preferences_snapshot_read personal_preferences_routines personal_preferences_routine_read personal_preferences_routine_explain personal_preferences_mind_map personal_preferences_playbooks
ai_terminal_integrations ai_terminal_detect ai_terminal_status ai_terminal_events personal_preferences_generated_skills personal_preferences_generated_skill personal_preferences_generated_skill_events personal_preferences_generated_skills_preview personal_preferences_generated_skills_render
clone_context clone_directive clone_explain clone_replay_dataset clone_replay_suite memory_layers memory_route get_profile`.split(/\s+/).map(name => `docdex_${name}`));
const memoryNames = new Set(`index memory_save memory_store conversation_import diary_write conversation_hook save_preference
personal_preferences_feedback personal_preferences_operator_event_record personal_preferences_generated_skill_validate`.split(/\s+/).map(name => `docdex_${name}`));
const externalNames = new Set(`conversation_delete conversation_redact conversation_prune kg_delete_edge kg_delete_episode kg_rebuild kg_clear
personal_preferences_review personal_preferences_process personal_preferences_scan personal_preferences_redact personal_preferences_delete personal_preferences_prune personal_preferences_purge personal_preferences_claim_review personal_preferences_claim_override personal_preferences_claim_forget
personal_preferences_operator_events_scan_artifacts personal_preferences_snapshots_rebuild personal_preferences_routines_rebuild ai_terminal_integrations_bootstrap ai_terminal_capture ai_terminal_sync_skills
personal_preferences_generated_skills_sync personal_preferences_generated_skills_autopilot personal_preferences_generated_skill_install personal_preferences_generated_skill_disable personal_preferences_generated_skill_rollback clone_evaluate clone_replay_evaluate`.split(/\s+/).map(name => `docdex_${name}`));
export type DocdexCatalogKind = "read" | "memory" | "web" | "external" | "delegate";
export const docdexCatalogKind = (name: string): DocdexCatalogKind | undefined => {
  if (readNames.has(name)) return "read";
  if (memoryNames.has(name)) return "memory";
  if (externalNames.has(name)) return "external";
  if (name === "docdex_web_research") return "web";
  if (name === "docdex_local_completion") return "delegate";
  return undefined; // Unknown operations never inherit a read permission.
};
export const docdexCatalogNames = new Set(docdexCatalog.map(tool => tool.name));
export const docdexCatalogOperation = (name: string): string | undefined => docdexCatalogNames.has(name) && docdexCatalogKind(name) ? name.replace(/^docdex_/, "") : undefined;
