import { createHash, randomUUID } from "node:crypto";
import { ToolExecutionError, type ToolDescriptor } from "../tools/ToolTypes.js";

export type PermissionProfile = "plan" | "ask" | "workspace";
export type PermissionKind = "read" | "write" | "shell" | "web" | "memory" | "media" | "external";
export interface PermissionRequest { id: string; tool: string; kind: PermissionKind; args: unknown; reason: string; }
export interface PermissionAnswer { allow: boolean; scope?: "once" | "session"; }
export interface PermissionGrants { schemaVersion: 1; grants: string[]; denials: string[]; }
export type PermissionPrompt = (request: PermissionRequest, signal?: AbortSignal) => Promise<PermissionAnswer>;

const fileRead = new Set(["prepare_edit", "read_file", "list_directory", "list_files", "stat_path", "diff_summary", "search", "search_files", "search_text", "glob", "file_search"]);
const fileWrite = new Set(["write_file", "apply_patch", "apply_diff", "media_export_artifact"]);
const controlRead = new Set(["work_status", "work_refine", "work_plan", "work_claim", "work_release", "work_reopen", "work_checkpoint", "work_decision", "work_verify", "work_complete", "work_block"]);
const docdexReads = /^(docdex_(search|batch_search|rerank|open|files|tree|stats|symbols|ast|repo_inspect|impact_graph|impact_diagnostics|dag_export|memory_recall|get_profile|wakeup|diary_read|capabilities|conversation_search|conversation_read|conversation_list|kg_query))$/;

export const permissionKind = (tool: ToolDescriptor): PermissionKind => {
  if (tool.name === "run_shell") return "shell";
  if (fileWrite.has(tool.name)) return "write";
  if (["tools_discover", "tools_enable"].includes(tool.name)) return "read";
  if (["media_job_status", "media_job_wait", "delegate_helper"].includes(tool.name)) return "read";
  if (tool.name === "media_job_cancel") return "media";
  if (/image.*generat|audio.*generat|video.*generat|media.*generat/.test(tool.name) || /^(image|audio|video|media)_generation$/.test(tool.capability)) return "media";
  if (tool.name === "docdex_web_research") return "web";
  if (/^docdex_(memory_save|save_preference|index|diary_write|conversation_import|delegate)/.test(tool.name)) return "memory";
  if ((fileRead.has(tool.name) || docdexReads.test(tool.name)) && tool.readOnly || controlRead.has(tool.name)) return "read";
  return "external";
};

export class PermissionGate {
  private grants = new Set<string>();
  private denials = new Set<string>();
  private revision = 1;
  constructor(public profile: PermissionProfile = "ask", private readonly prompt?: PermissionPrompt, private readonly options: { shellIsolated?: boolean; allowWeb?: boolean; allowMemory?: boolean; allowMedia?: boolean; deniedTools?: string[] } = {}) {}

  inspect(): Record<string, unknown> {
    return { profile: this.profile, revision: this.revision, sessionGrants: this.grants.size, sessionDenials: this.denials.size, shellIsolated: this.options.shellIsolated === true, allowWeb: this.options.allowWeb === true, allowMemory: this.options.allowMemory === true, allowMedia: this.options.allowMedia === true, deniedTools: this.options.deniedTools ?? [] };
  }

  setProfile(profile: PermissionProfile): void {
    if (!["plan", "ask", "workspace"].includes(profile)) throw new Error("Unknown permission profile");
    this.profile = profile; this.revision += 1;
  }

  clearGrants(): void { this.grants.clear(); this.denials.clear(); this.revision += 1; }

  exportGrants(): PermissionGrants { return { schemaVersion: 1, grants: [...this.grants], denials: [...this.denials] }; }

  restoreGrants(value: PermissionGrants): void {
    if (value.schemaVersion !== 1 || !Array.isArray(value.grants) || !Array.isArray(value.denials) || [...value.grants, ...value.denials].some(key => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))) throw new Error("Invalid permission grant record");
    this.grants = new Set(value.grants); this.denials = new Set(value.denials); this.revision += 1;
  }

  async authorize(tool: ToolDescriptor, args: unknown, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const kind = permissionKind(tool);
    const key = createHash("sha256").update(JSON.stringify([tool.name, kind, args])).digest("hex");
    const deny = (reason: string): never => { throw new ToolExecutionError("tool_permission_denied", reason, { retryable: false, details: { tool: tool.name, kind } }); };
    if (this.options.deniedTools?.includes(tool.name) || this.denials.has(key)) deny("Operation explicitly denied");
    if (kind === "read") return;
    if (this.profile === "plan") deny("Planning mode permits read operations only");
    if (kind === "web" && this.options.allowWeb) return;
    if (kind === "memory" && this.options.allowMemory) return;
    if (kind === "media" && this.options.allowMedia) return;
    if (kind === "shell" && !this.options.shellIsolated) deny("An isolated shell executor is required; run codali doctor");
    if (this.profile === "workspace" && (kind === "write" || kind === "shell")) return;
    if (this.grants.has(key)) return;
    if (!this.prompt) deny("Permission is required; interactive approval or an applicable grant is unavailable");
    const revision = this.revision;
    const answer = await this.prompt!({ id: randomUUID(), tool: tool.name, kind, args, reason: `Allow ${kind} operation ${tool.name}?` }, signal);
    signal?.throwIfAborted();
    if (revision !== this.revision) return this.authorize(tool, args, signal);
    if (!answer.allow) { if (answer.scope === "session") this.denials.add(key); deny("Operation denied by user"); }
    if (answer.scope === "session") this.grants.add(key);
  }
}
