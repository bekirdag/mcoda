import path from "node:path";
import { promises as fs } from "node:fs";
import { AgentService } from "@mcoda/agents";
import {
  EpicInsert,
  EpicRow,
  GlobalRepository,
  StoryInsert,
  StoryRow,
  TaskDependencyInsert,
  TaskDependencyRow,
  TaskInsert,
  TaskRow,
  WorkspaceRepository,
} from "@mcoda/db";
import { Agent } from "@mcoda/shared";
import { setTimeout as delay } from "node:timers/promises";
import { DocdexClient, DocdexDocument } from "@mcoda/integrations";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { RoutingService } from "../agents/RoutingService.js";
import {
  createEpicKeyGenerator,
  createStoryKeyGenerator,
  createTaskKeyGenerator,
} from "./KeyHelpers.js";

export interface CreateTasksOptions {
  workspace: WorkspaceResolution;
  projectKey: string;
  inputs: string[];
  agentName?: string;
  agentStream?: boolean;
  maxEpics?: number;
  maxStoriesPerEpic?: number;
  maxTasksPerStory?: number;
  force?: boolean;
}

export interface CreateTasksResult {
  jobId: string;
  commandRunId: string;
  epics: EpicRow[];
  stories: StoryRow[];
  tasks: TaskRow[];
  dependencies: TaskDependencyRow[];
}

interface AgentTaskNode {
  localId?: string;
  title: string;
  type?: string;
  description?: string;
  estimatedStoryPoints?: number;
  priorityHint?: number;
  dependsOnKeys?: string[];
  relatedDocs?: string[];
  unitTests?: string[];
  componentTests?: string[];
  integrationTests?: string[];
  apiTests?: string[];
}

interface AgentStoryNode {
  localId?: string;
  title: string;
  userStory?: string;
  description?: string;
  acceptanceCriteria?: string[];
  relatedDocs?: string[];
  priorityHint?: number;
  tasks: AgentTaskNode[];
}

interface AgentEpicNode {
  localId?: string;
  area?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  relatedDocs?: string[];
  priorityHint?: number;
  stories: AgentStoryNode[];
}

interface AgentPlan {
  epics: AgentEpicNode[];
}

interface PlanEpic extends AgentEpicNode {
  localId: string;
}

interface PlanStory extends AgentStoryNode {
  localId: string;
  epicLocalId: string;
}

interface PlanTask extends AgentTaskNode {
  localId: string;
  storyLocalId: string;
  epicLocalId: string;
}

interface GeneratedPlan {
  epics: PlanEpic[];
  stories: PlanStory[];
  tasks: PlanTask[];
}

const formatBullets = (items: string[] | undefined, fallback: string): string => {
  if (!items || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
};

const formatTestList = (items: string[] | undefined): string => {
  if (!items || items.length === 0) return "Not applicable";
  return items.join("; ");
};

const ensureNonEmpty = (value: string | undefined, fallback: string): string =>
  value && value.trim().length > 0 ? value.trim() : fallback;

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
const DOC_CONTEXT_BUDGET = 8000;

const inferDocType = (filePath: string): string => {
  const name = path.basename(filePath).toLowerCase();
  if (name.includes("sds")) return "SDS";
  if (name.includes("pdr")) return "PDR";
  if (name.includes("rfp")) return "RFP";
  return "DOC";
};

const describeDoc = (doc: DocdexDocument, idx: number): string => {
  const title = doc.title ?? doc.path ?? doc.id ?? `doc-${idx + 1}`;
  const source = doc.path ?? doc.id ?? "docdex";
  const head = doc.content ? doc.content.split(/\r?\n/).slice(0, 3).join(" ").slice(0, 240) : "";
  return `- [${doc.docType}] ${title} (handle: docdex:${doc.id ?? `doc-${idx + 1}`}, source: ${source})${
    head ? `\n  Excerpt: ${head}` : ""
  }`;
};

const extractJson = (raw: string): any | undefined => {
  const fenced = raw.match(/```json([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  const body = candidate.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

const buildEpicDescription = (
  epicKey: string,
  title: string,
  description: string | undefined,
  acceptance: string[] | undefined,
  relatedDocs: string[] | undefined,
): string => {
  return [
    `* **Epic Key**: ${epicKey}`,
    `* **Epic Title**: ${title}`,
    "* **Context / Problem**",
    "",
    ensureNonEmpty(description, "Summarize the problem, users, and constraints for this epic."),
    "* **Goals & Outcomes**",
    formatBullets(acceptance, "List measurable outcomes for this epic."),
    "* **In Scope**",
    "- Clarify during refinement; derived from RFP/PDR/SDS.",
    "* **Out of Scope**",
    "- To be defined; exclude unrelated systems.",
    "* **Key Flows / Scenarios**",
    "- Outline primary user flows for this epic.",
    "* **Non-functional Requirements**",
    "- Performance, security, reliability expectations go here.",
    "* **Dependencies & Constraints**",
    "- Capture upstream/downstream systems and blockers.",
    "* **Risks & Open Questions**",
    "- Identify risks and unknowns to resolve.",
    "* **Acceptance Criteria**",
    formatBullets(acceptance, "Provide 5–10 testable acceptance criteria."),
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "Link relevant docdex entries and sections."),
  ].join("\n");
};

const buildStoryDescription = (
  storyKey: string,
  title: string,
  userStory: string | undefined,
  description: string | undefined,
  acceptanceCriteria: string[] | undefined,
  relatedDocs: string[] | undefined,
): string => {
  return [
    `* **Story Key**: ${storyKey}`,
    "* **User Story**",
    "",
    ensureNonEmpty(userStory, `As a user, I want ${title} so that it delivers value.`),
    "* **Context**",
    "",
    ensureNonEmpty(description, "Context for systems, dependencies, and scope."),
    "* **Preconditions / Assumptions**",
    "- Confirm required data, environments, and access.",
    "* **Main Flow**",
    "- Outline the happy path for this story.",
    "* **Alternative / Error Flows**",
    "- Capture error handling and non-happy paths.",
    "* **UX / UI Notes**",
    "- Enumerate screens/states if applicable.",
    "* **Data & Integrations**",
    "- Note key entities, APIs, queues, or third-party dependencies.",
    "* **Acceptance Criteria**",
    formatBullets(acceptanceCriteria, "List testable outcomes for this story."),
    "* **Non-functional Requirements**",
    "- Add story-specific performance/reliability/security expectations.",
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "Docdex handles, OpenAPI endpoints, code modules."),
  ].join("\n");
};

const buildTaskDescription = (
  taskKey: string,
  title: string,
  description: string | undefined,
  storyKey: string,
  epicKey: string,
  relatedDocs: string[] | undefined,
  dependencies: string[],
  tests: {
    unitTests?: string[];
    componentTests?: string[];
    integrationTests?: string[];
    apiTests?: string[];
  },
): string => {
  return [
    `* **Task Key**: ${taskKey}`,
    "* **Objective**",
    "",
    ensureNonEmpty(description, `Deliver ${title} for story ${storyKey}.`),
    "* **Context**",
    "",
    `- Epic: ${epicKey}`,
    `- Story: ${storyKey}`,
    "* **Inputs**",
    formatBullets(relatedDocs, "Docdex excerpts, SDS/PDR/RFP sections, OpenAPI endpoints."),
    "* **Implementation Plan**",
    "- Break this into concrete steps during execution.",
    "* **Definition of Done**",
    "- Tests passing, docs updated, review/QA complete.",
    "* **Testing & QA**",
    `- Unit tests: ${formatTestList(tests.unitTests)}`,
    `- Component tests: ${formatTestList(tests.componentTests)}`,
    `- Integration tests: ${formatTestList(tests.integrationTests)}`,
    `- API tests: ${formatTestList(tests.apiTests)}`,
    "* **Dependencies**",
    formatBullets(dependencies, "Enumerate prerequisite tasks by key."),
    "* **Risks & Gotchas**",
    "- Highlight edge cases or risky areas.",
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "Docdex handles or file paths to consult."),
  ].join("\n");
};

const collectFilesRecursively = async (target: string): Promise<string[]> => {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target);
    const results: string[] = [];
    for (const entry of entries) {
      const child = path.join(target, entry);
      const childStat = await fs.stat(child);
      if (childStat.isDirectory()) {
        results.push(...(await collectFilesRecursively(child)));
      } else {
        results.push(child);
      }
    }
    return results;
  }
  return [target];
};

const EPIC_SCHEMA_SNIPPET = `{
  "epics": [
    {
      "localId": "e1",
      "area": "web|adm|bck|ops|infra|mobile",
      "title": "Epic title",
      "description": "Epic description using the epic template",
      "acceptanceCriteria": ["criterion"],
      "relatedDocs": ["docdex:..."],
      "priorityHint": 50
    }
  ]
}`;

const STORY_SCHEMA_SNIPPET = `{
  "stories": [
    {
      "localId": "us1",
      "title": "Story title",
      "userStory": "As a ...",
      "description": "Story description using the template",
      "acceptanceCriteria": ["criterion"],
      "relatedDocs": ["docdex:..."],
      "priorityHint": 50
    }
  ]
}`;

const TASK_SCHEMA_SNIPPET = `{
  "tasks": [
    {
      "localId": "t1",
      "title": "Task title",
      "type": "feature|bug|chore|spike",
      "description": "Task description using the template",
      "estimatedStoryPoints": 3,
      "priorityHint": 50,
      "dependsOnKeys": ["t0"],
      "relatedDocs": ["docdex:..."],
      "unitTests": ["unit test description"],
      "componentTests": ["component test description"],
      "integrationTests": ["integration test description"],
      "apiTests": ["api test description"]
    }
  ]
}`;

export class CreateTasksService {
  private static readonly MAX_BUSY_RETRIES = 6;
  private static readonly BUSY_BACKOFF_MS = 500;
  private docdex: DocdexClient;
  private jobService: JobService;
  private agentService: AgentService;
  private repo: GlobalRepository;
  private workspaceRepo: WorkspaceRepository;
  private routingService: RoutingService;
  private workspace: WorkspaceResolution;

  constructor(
    workspace: WorkspaceResolution,
    deps: {
      docdex: DocdexClient;
      jobService: JobService;
      agentService: AgentService;
      repo: GlobalRepository;
      workspaceRepo: WorkspaceRepository;
      routingService: RoutingService;
    },
  ) {
    this.workspace = workspace;
    this.docdex = deps.docdex;
    this.jobService = deps.jobService;
    this.agentService = deps.agentService;
    this.repo = deps.repo;
    this.workspaceRepo = deps.workspaceRepo;
    this.routingService = deps.routingService;
  }

  static async create(workspace: WorkspaceResolution): Promise<CreateTasksService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const routingService = await RoutingService.create();
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
    });
    const jobService = new JobService(workspace);
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    return new CreateTasksService(workspace, {
      docdex,
      jobService,
      agentService,
      repo,
      workspaceRepo,
      routingService,
    });
  }

  async close(): Promise<void> {
    const swallow = async (fn?: () => Promise<void>) => {
      try {
        if (fn) await fn();
      } catch {
        // Best-effort close; ignore errors (including "database is closed").
      }
    };
    await swallow((this.agentService as any).close?.bind(this.agentService));
    await swallow((this.repo as any).close?.bind(this.repo));
    await swallow((this.jobService as any).close?.bind(this.jobService));
    await swallow((this.workspaceRepo as any).close?.bind(this.workspaceRepo));
    await swallow((this.routingService as any).close?.bind(this.routingService));
    const docdex = this.docdex as any;
    await swallow(docdex?.close?.bind(docdex));
  }

  private async resolveAgent(agentName?: string): Promise<Agent> {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "create-tasks",
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
  }

  private async prepareDocs(inputs: string[]): Promise<DocdexDocument[]> {
    const documents: DocdexDocument[] = [];
    for (const input of inputs) {
      if (input.startsWith("docdex:")) {
        const docId = input.replace(/^docdex:/, "");
        try {
          const doc = await this.docdex.fetchDocumentById(docId);
          documents.push(doc);
        } catch (error) {
          throw new Error(`Docdex reference failed (${docId}): ${(error as Error).message}`);
        }
        continue;
      }
      const resolved = path.isAbsolute(input) ? input : path.join(this.workspace.workspaceRoot, input);
      let paths: string[];
      try {
        paths = await collectFilesRecursively(resolved);
      } catch (error) {
        throw new Error(`Failed to read input ${input}: ${(error as Error).message}`);
      }
      for (const filePath of paths) {
        const docType = inferDocType(filePath);
        try {
          const doc = await this.docdex.ensureRegisteredFromFile(filePath, docType, {
            projectKey: this.workspace.workspaceId,
          });
          documents.push(doc);
        } catch (error) {
          throw new Error(`Docdex register failed for ${filePath}: ${(error as Error).message}`);
        }
      }
    }
    return documents;
  }

  private buildDocContext(docs: DocdexDocument[]): { docSummary: string; warnings: string[] } {
    const warnings: string[] = [];
    const blocks: string[] = [];
    let budget = DOC_CONTEXT_BUDGET;
    const sorted = [...docs].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    for (const [idx, doc] of sorted.entries()) {
      const segments = (doc.segments ?? []).slice(0, 5);
      const content = segments.length
        ? segments
            .map((seg, i) => {
              const trimmed = seg.content.length > 600 ? `${seg.content.slice(0, 600)}...` : seg.content;
              return `  - (${i + 1}) ${seg.heading ? `${seg.heading}: ` : ""}${trimmed}`;
            })
            .join("\n")
        : doc.content
          ? doc.content.slice(0, 800)
          : "";
      const entry = [`[${doc.docType}] docdex:${doc.id ?? `doc-${idx + 1}`}`, describeDoc(doc, idx), content]
        .filter(Boolean)
        .join("\n");
      const cost = estimateTokens(entry);
      if (budget - cost < 0) {
        warnings.push(`Context truncated due to token budget; skipped doc ${doc.id ?? doc.path ?? idx + 1}.`);
        continue;
      }
      budget -= cost;
      blocks.push(entry);
      if (budget <= 0) break;
    }
    return { docSummary: blocks.join("\n\n") || "(no docs)", warnings };
  }

  private buildPrompt(
    projectKey: string,
    docs: DocdexDocument[],
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number },
  ): { prompt: string; docSummary: string } {
    const docSummary = docs.map((doc, idx) => describeDoc(doc, idx)).join("\n");
    const limits = [
      options.maxEpics ? `Limit epics to ${options.maxEpics}.` : "",
      options.maxStoriesPerEpic ? `Limit stories per epic to ${options.maxStoriesPerEpic}.` : "",
      options.maxTasksPerStory ? `Limit tasks per story to ${options.maxTasksPerStory}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const prompt = [
      `You are assisting in creating EPICS ONLY for project ${projectKey}.`,
      "Follow mcoda SDS epic template:",
      "- Context/Problem; Goals & Outcomes; In Scope; Out of Scope; Key Flows; Non-functional Requirements; Dependencies & Constraints; Risks & Open Questions; Acceptance Criteria; Related Documentation.",
      "Return strictly valid JSON (no prose) matching:",
      EPIC_SCHEMA_SNIPPET,
      "Rules:",
      "- Do NOT include final slugs; the system will assign keys.",
      "- Use docdex handles when referencing docs.",
      "- acceptanceCriteria must be an array of strings (5-10 items).",
      limits || "Use reasonable scope without over-generating epics.",
      "Docs available:",
      docSummary || "- (no docs provided; propose sensible epics).",
    ].join("\n\n");
    return { prompt, docSummary };
  }

  private fallbackPlan(projectKey: string, docs: DocdexDocument[]): AgentPlan {
    const docRefs = docs.map((doc) => doc.id ?? doc.path ?? doc.title ?? "doc");
    return {
      epics: [
        {
          area: projectKey,
          title: `Initial planning for ${projectKey}`,
          description: `Seed epic derived from provided documentation (${docRefs.join(", ")})`,
          acceptanceCriteria: ["Backlog created with actionable tasks", "Dependencies identified", "Tasks grouped by user value"],
          relatedDocs: docRefs,
          stories: [
            {
              localId: "story-1",
              title: "Review inputs and draft backlog",
              userStory: "As a planner, I want a decomposed backlog so that work can be prioritized.",
              description: "Review provided docs and produce a first-pass backlog.",
              acceptanceCriteria: [
                "Epics, stories, and tasks are listed",
                "Each task has an objective and DoD",
                "Dependencies noted",
              ],
              relatedDocs: docRefs,
              tasks: [
                {
                  localId: "task-1",
                  title: "Summarize requirements",
                  type: "chore",
                  description: "Summarize key asks from docs and SDS/PDR/RFP inputs.",
                  estimatedStoryPoints: 1,
                  priorityHint: 10,
                  relatedDocs: docRefs,
                  unitTests: [],
                  componentTests: [],
                  integrationTests: [],
                  apiTests: [],
                },
                {
                  localId: "task-2",
                  title: "Propose tasks and ordering",
                  type: "feature",
                  description: "Break down the scope into tasks with initial dependencies.",
                  estimatedStoryPoints: 2,
                  priorityHint: 20,
                  dependsOnKeys: ["task-1"],
                  relatedDocs: docRefs,
                  unitTests: [],
                  componentTests: [],
                  integrationTests: [],
                  apiTests: [],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  private async invokeAgentWithRetry(
    agent: Agent,
    prompt: string,
    action: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ output: string; promptTokens: number; completionTokens: number }> {
    const startedAt = Date.now();
    let output = "";
    const logChunk = async (chunk?: string) => {
      if (!chunk) return;
      await this.jobService.appendLog(jobId, chunk);
      if (stream) process.stdout.write(chunk);
    };
    try {
      if (stream) {
        const gen = await this.agentService.invokeStream(agent.id, { input: prompt });
        for await (const chunk of gen) {
          output += chunk.output ?? "";
          await logChunk(chunk.output);
        }
      } else {
        const result = await this.agentService.invoke(agent.id, { input: prompt });
        output = result.output ?? "";
        await logChunk(output);
      }
    } catch (error) {
      throw new Error(`Agent invocation failed (${action}): ${(error as Error).message}`);
    }
    let parsed = extractJson(output);
    if (!parsed) {
      const fixPrompt = [
        "Rewrite the previous response into valid JSON matching the expected schema.",
        `Schema hint:\n${action === "epics" ? EPIC_SCHEMA_SNIPPET : action === "stories" ? STORY_SCHEMA_SNIPPET : TASK_SCHEMA_SNIPPET}`,
        "Return JSON only; no prose.",
        `Original content:\n${output}`,
      ].join("\n\n");
      try {
        const fix = await this.agentService.invoke(agent.id, { input: fixPrompt });
        output = fix.output ?? "";
        parsed = extractJson(output);
      } catch (error) {
        throw new Error(`Agent retry failed (${action}): ${(error as Error).message}`);
      }
    }
    if (!parsed) {
      throw new Error(`Agent output was not valid JSON for ${action}`);
    }
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(output);
    const durationSeconds = (Date.now() - startedAt) / 1000;
    await this.jobService.recordTokenUsage({
      timestamp: new Date().toISOString(),
      workspaceId: this.workspace.workspaceId,
      jobId,
      commandRunId,
      agentId: agent.id,
      modelName: agent.defaultModel,
      promptTokens,
      completionTokens,
      tokensPrompt: promptTokens,
      tokensCompletion: completionTokens,
      tokensTotal: promptTokens + completionTokens,
      durationSeconds,
      metadata: { action: `create_tasks_${action}`, ...(metadata ?? {}) },
    });
    return { output, promptTokens, completionTokens };
  }

  private parseEpics(output: string, fallbackDocs: DocdexDocument[], projectKey: string): AgentEpicNode[] {
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.epics) || parsed.epics.length === 0) {
      throw new Error("Agent did not return epics in expected format");
    }
    return (parsed.epics as any[])
      .map((epic, idx) => ({
        localId: epic.localId ?? `e${idx + 1}`,
        area: epic.area,
        title: epic.title ?? "Epic",
        description: epic.description,
        acceptanceCriteria: Array.isArray(epic.acceptanceCriteria) ? epic.acceptanceCriteria : [],
        relatedDocs: Array.isArray(epic.relatedDocs) ? epic.relatedDocs : [],
        priorityHint: typeof epic.priorityHint === "number" ? epic.priorityHint : undefined,
        stories: [],
      }))
      .filter((e) => e.title);
  }

  private async generateStoriesForEpic(
    agent: Agent,
    epic: AgentEpicNode & { key?: string },
    docSummary: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
  ): Promise<AgentStoryNode[]> {
    const prompt = [
      `Generate user stories for epic "${epic.title}".`,
      "Use the User Story template: User Story; Context; Preconditions; Main Flow; Alternative/Error Flows; UX/UI; Data & Integrations; Acceptance Criteria; NFR; Related Docs.",
      "Return JSON only matching:",
      STORY_SCHEMA_SNIPPET,
      "Rules:",
      "- No tasks in this step.",
      "- acceptanceCriteria must be an array of strings.",
      "- Use docdex handles when citing docs.",
      `Epic context (key=${epic.key ?? epic.localId ?? "TBD"}):`,
      epic.description ?? "(no description provided)",
      `Docs: ${docSummary || "none"}`,
    ].join("\n\n");
    const { output } = await this.invokeAgentWithRetry(agent, prompt, "stories", stream, jobId, commandRunId, {
      epicKey: epic.key ?? epic.localId,
    });
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.stories) || parsed.stories.length === 0) {
      throw new Error(`Agent did not return stories for epic ${epic.title}`);
    }
    return parsed.stories
      .map((story: any, idx: number) => ({
        localId: story.localId ?? `us${idx + 1}`,
        title: story.title ?? "Story",
        userStory: story.userStory ?? story.description,
        description: story.description,
        acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
        relatedDocs: Array.isArray(story.relatedDocs) ? story.relatedDocs : [],
        priorityHint: typeof story.priorityHint === "number" ? story.priorityHint : undefined,
        tasks: [],
      }))
      .filter((s: AgentStoryNode) => s.title);
  }

  private async generateTasksForStory(
    agent: Agent,
    epic: { key?: string; title: string },
    story: AgentStoryNode & { key?: string },
    docSummary: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
  ): Promise<AgentTaskNode[]> {
    const parseTestList = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    };
    const prompt = [
      `Generate tasks for story "${story.title}" (Epic: ${epic.title}).`,
      "Use the Task template: Objective; Context; Inputs; Implementation Plan; DoD; Testing & QA; Dependencies; Risks; References.",
      "Return JSON only matching:",
      TASK_SCHEMA_SNIPPET,
      "Rules:",
      "- Each task must include localId, title, description, type, estimatedStoryPoints, priorityHint.",
      "- Include test arrays: unitTests, componentTests, integrationTests, apiTests. Use [] when not applicable.",
      "- Only include tests that are relevant to the task's scope.",
      "- dependsOnKeys must reference localIds in this story.",
      "- Use docdex handles when citing docs.",
      `Story context (key=${story.key ?? story.localId ?? "TBD"}):`,
      story.description ?? story.userStory ?? "",
      `Acceptance criteria: ${(story.acceptanceCriteria ?? []).join("; ")}`,
      `Docs: ${docSummary || "none"}`,
    ].join("\n\n");
    const { output } = await this.invokeAgentWithRetry(agent, prompt, "tasks", stream, jobId, commandRunId, {
      epicKey: epic.key,
      storyKey: story.key ?? story.localId,
    });
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new Error(`Agent did not return tasks for story ${story.title}`);
    }
    return parsed.tasks
      .map((task: any, idx: number) => ({
        localId: task.localId ?? `t${idx + 1}`,
        title: task.title ?? "Task",
        type: task.type,
        description: task.description,
        estimatedStoryPoints: typeof task.estimatedStoryPoints === "number" ? task.estimatedStoryPoints : undefined,
        priorityHint: typeof task.priorityHint === "number" ? task.priorityHint : undefined,
        dependsOnKeys: Array.isArray(task.dependsOnKeys) ? task.dependsOnKeys : [],
        relatedDocs: Array.isArray(task.relatedDocs) ? task.relatedDocs : [],
        unitTests: parseTestList(task.unitTests),
        componentTests: parseTestList(task.componentTests),
        integrationTests: parseTestList(task.integrationTests),
        apiTests: parseTestList(task.apiTests),
      }))
      .filter((t: AgentTaskNode) => t.title);
  }

  private async generatePlanFromAgent(
    epics: AgentEpicNode[],
    agent: Agent,
    docSummary: string,
    options: { agentStream: boolean; jobId: string; commandRunId: string; maxStoriesPerEpic?: number; maxTasksPerStory?: number },
  ): Promise<GeneratedPlan> {
    const planEpics: PlanEpic[] = epics.map((epic, idx) => ({
      ...epic,
      localId: epic.localId ?? `e${idx + 1}`,
    }));

    const planStories: PlanStory[] = [];
    const planTasks: PlanTask[] = [];

    for (const epic of planEpics) {
      const stories = await this.generateStoriesForEpic(
        agent,
        { ...epic },
        docSummary,
        options.agentStream,
        options.jobId,
        options.commandRunId,
      );
      const limitedStories = stories.slice(0, options.maxStoriesPerEpic ?? stories.length);
      limitedStories.forEach((story, idx) => {
        planStories.push({
          ...story,
          localId: story.localId ?? `us${idx + 1}`,
          epicLocalId: epic.localId,
        });
      });
    }

    for (const story of planStories) {
      const tasks = await this.generateTasksForStory(
        agent,
        { key: story.epicLocalId, title: story.title },
        story,
        docSummary,
        options.agentStream,
        options.jobId,
        options.commandRunId,
      );
      const limitedTasks = tasks.slice(0, options.maxTasksPerStory ?? tasks.length);
      limitedTasks.forEach((task, idx) => {
        planTasks.push({
          ...task,
          localId: task.localId ?? `t${idx + 1}`,
          storyLocalId: story.localId,
          epicLocalId: story.epicLocalId,
        });
      });
    }

    return { epics: planEpics, stories: planStories, tasks: planTasks };
  }

  private async writePlanArtifacts(
    projectKey: string,
    plan: GeneratedPlan,
    docSummary: string,
  ): Promise<{ folder: string }> {
    const baseDir = path.join(this.workspace.workspaceRoot, ".mcoda", "tasks", projectKey);
    await fs.mkdir(baseDir, { recursive: true });
    const write = async (file: string, data: unknown) => {
      const target = path.join(baseDir, file);
      await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
    };
    await write("plan.json", { projectKey, generatedAt: new Date().toISOString(), docSummary, ...plan });
    await write("epics.json", plan.epics);
    await write("stories.json", plan.stories);
    await write("tasks.json", plan.tasks);
    return { folder: baseDir };
  }

  private async persistPlanToDb(
    projectId: string,
    projectKey: string,
    plan: GeneratedPlan,
    jobId: string,
    commandRunId: string,
    options?: { force?: boolean; resetKeys?: boolean },
  ): Promise<{ epics: EpicRow[]; stories: StoryRow[]; tasks: TaskRow[]; dependencies: TaskDependencyRow[] }> {
    const resetKeys = options?.resetKeys ?? false;
    const existingEpicKeys = resetKeys ? [] : await this.workspaceRepo.listEpicKeys(projectId);
    const epicKeyGen = createEpicKeyGenerator(projectKey, existingEpicKeys);

    const epicInserts: EpicInsert[] = [];
    const epicMeta: { key: string; node: PlanEpic }[] = [];

    for (const epic of plan.epics) {
      const key = epicKeyGen(epic.area);
      epicInserts.push({
        projectId,
        key,
        title: epic.title || `Epic ${key}`,
        description: buildEpicDescription(
          key,
          epic.title || `Epic ${key}`,
          epic.description,
          epic.acceptanceCriteria,
          epic.relatedDocs,
        ),
        storyPointsTotal: null,
        priority: epic.priorityHint ?? (epicInserts.length + 1),
        metadata: epic.relatedDocs ? { doc_links: epic.relatedDocs } : undefined,
      });
      epicMeta.push({ key, node: epic });
    }

    let epicRows: EpicRow[] = [];
    let storyRows: StoryRow[] = [];
    let taskRows: TaskRow[] = [];
    let dependencyRows: TaskDependencyRow[] = [];

    await this.workspaceRepo.withTransaction(async () => {
      if (options?.force) {
        await this.workspaceRepo.deleteProjectBacklog(projectId, false);
      }
      epicRows = await this.workspaceRepo.insertEpics(epicInserts, false);

      const storyInserts: StoryInsert[] = [];
      const storyMeta: { storyKey: string; epicKey: string; node: PlanStory }[] = [];
      for (const epic of epicMeta) {
        const epicRow = epicRows.find((row) => row.key === epic.key);
        if (!epicRow) continue;
        const stories = plan.stories.filter((s) => s.epicLocalId === epic.node.localId);
        const existingStoryKeys = await this.workspaceRepo.listStoryKeys(epicRow.id);
        const storyKeyGen = createStoryKeyGenerator(epicRow.key, existingStoryKeys);
        for (const story of stories) {
          const storyKey = storyKeyGen();
          storyInserts.push({
            projectId,
            epicId: epicRow.id,
            key: storyKey,
            title: story.title || `Story ${storyKey}`,
            description: buildStoryDescription(
              storyKey,
              story.title || `Story ${storyKey}`,
              story.userStory,
              story.description,
              story.acceptanceCriteria,
              story.relatedDocs,
            ),
            acceptanceCriteria: story.acceptanceCriteria?.join("\n") ?? undefined,
            storyPointsTotal: null,
            priority: story.priorityHint ?? (storyInserts.length + 1),
            metadata: story.relatedDocs ? { doc_links: story.relatedDocs } : undefined,
          });
          storyMeta.push({ storyKey, epicKey: epicRow.key, node: story });
        }
      }

      storyRows = await this.workspaceRepo.insertStories(storyInserts, false);
      const storyIdByKey = new Map(storyRows.map((row) => [row.key, row.id]));
      const epicIdByKey = new Map(epicRows.map((row) => [row.key, row.id]));

      type TaskDetail = { localId: string; key: string; storyKey: string; epicKey: string; plan: PlanTask };
      const taskDetails: TaskDetail[] = [];
      for (const story of storyMeta) {
        const storyId = storyIdByKey.get(story.storyKey);
        const existingTaskKeys = storyId ? await this.workspaceRepo.listTaskKeys(storyId) : [];
        const tasks = plan.tasks.filter((t) => t.storyLocalId === story.node.localId);
        const taskKeyGen = createTaskKeyGenerator(story.storyKey, existingTaskKeys);
        for (const task of tasks) {
          const key = taskKeyGen();
          const localId = task.localId ?? key;
          taskDetails.push({
            localId,
            key,
            storyKey: story.storyKey,
            epicKey: story.epicKey,
            plan: task,
          });
        }
      }

      const localToKey = new Map(taskDetails.map((t) => [t.localId, t.key]));
      const taskInserts: TaskInsert[] = [];
      for (const task of taskDetails) {
        const storyId = storyIdByKey.get(task.storyKey);
        const epicId = epicIdByKey.get(task.epicKey);
        if (!storyId || !epicId) continue;
        const depSlugs = (task.plan.dependsOnKeys ?? [])
          .map((dep) => localToKey.get(dep))
          .filter((value): value is string => Boolean(value));
        taskInserts.push({
          projectId,
          epicId,
          userStoryId: storyId,
          key: task.key,
          title: task.plan.title ?? `Task ${task.key}`,
          description: buildTaskDescription(
            task.key,
            task.plan.title ?? `Task ${task.key}`,
            task.plan.description,
            task.storyKey,
            task.epicKey,
            task.plan.relatedDocs,
            depSlugs,
            {
              unitTests: task.plan.unitTests,
              componentTests: task.plan.componentTests,
              integrationTests: task.plan.integrationTests,
              apiTests: task.plan.apiTests,
            },
          ),
          type: task.plan.type ?? "feature",
          status: "not_started",
          storyPoints: task.plan.estimatedStoryPoints ?? null,
          priority: task.plan.priorityHint ?? (taskInserts.length + 1),
          metadata: {
            doc_links: task.plan.relatedDocs ?? [],
            test_requirements: {
              unit: task.plan.unitTests ?? [],
              component: task.plan.componentTests ?? [],
              integration: task.plan.integrationTests ?? [],
              api: task.plan.apiTests ?? [],
            },
          },
        });
      }

      taskRows = await this.workspaceRepo.insertTasks(taskInserts, false);
      const taskByLocal = new Map<string, TaskRow>();
      for (const detail of taskDetails) {
        const row = taskRows.find((t) => t.key === detail.key);
        if (row) {
          taskByLocal.set(detail.localId, row);
        }
      }

      const depKeys = new Set<string>();
      const dependencies: TaskDependencyInsert[] = [];
      for (const detail of taskDetails) {
        const current = taskByLocal.get(detail.localId);
        if (!current) continue;
        for (const dep of detail.plan.dependsOnKeys ?? []) {
          const target = taskByLocal.get(dep);
          if (!target || target.id === current.id) continue;
          const depKey = `${current.id}|${target.id}|blocks`;
          if (depKeys.has(depKey)) continue;
          depKeys.add(depKey);
          dependencies.push({
            taskId: current.id,
            dependsOnTaskId: target.id,
            relationType: "blocks",
          });
        }
      }

      if (dependencies.length > 0) {
        dependencyRows = await this.workspaceRepo.insertTaskDependencies(dependencies, false);
      }

      // Roll up story and epic story point totals.
      const storySpTotals = new Map<string, number>();
      for (const task of taskRows) {
        if (typeof task.storyPoints === "number") {
          storySpTotals.set(task.userStoryId, (storySpTotals.get(task.userStoryId) ?? 0) + task.storyPoints);
        }
      }
      for (const [storyId, total] of storySpTotals.entries()) {
        await this.workspaceRepo.updateStoryPointsTotal(storyId, total);
      }
      const epicSpTotals = new Map<string, number>();
      for (const story of storyRows) {
        if (typeof story.storyPointsTotal === "number") {
          epicSpTotals.set(story.epicId, (epicSpTotals.get(story.epicId) ?? 0) + (story.storyPointsTotal ?? 0));
        }
      }
      for (const [epicId, total] of epicSpTotals.entries()) {
        await this.workspaceRepo.updateEpicStoryPointsTotal(epicId, total);
      }

      const now = new Date().toISOString();
      for (const task of taskRows) {
        await this.workspaceRepo.createTaskRun({
          taskId: task.id,
          command: "create-tasks",
          status: "succeeded",
          jobId,
          commandRunId,
          startedAt: now,
          finishedAt: now,
          runContext: { key: task.key },
        });
      }
    });

    return { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows };
  }

  async createTasks(options: CreateTasksOptions): Promise<CreateTasksResult> {
    const agentStream = options.agentStream !== false;
    const commandRun = await this.jobService.startCommandRun("create-tasks", options.projectKey);
    const job = await this.jobService.startJob(
      "create_tasks",
      commandRun.id,
      options.projectKey,
      {
        commandName: "create-tasks",
        payload: {
          projectKey: options.projectKey,
          inputs: options.inputs,
          agent: options.agentName,
          agentStream,
        },
      },
    );

    let lastError: unknown;
    for (let attempt = 1; attempt <= CreateTasksService.MAX_BUSY_RETRIES; attempt++) {
      try {
        const project = await this.workspaceRepo.createProjectIfMissing({
          key: options.projectKey,
          name: options.projectKey,
          description: `Workspace project ${options.projectKey}`,
        });

        const docs = await this.prepareDocs(options.inputs);
        const { docSummary, warnings: docWarnings } = this.buildDocContext(docs);
        const { prompt } = this.buildPrompt(options.projectKey, docs, options);
        await this.jobService.writeCheckpoint(job.id, {
          stage: "docs_indexed",
          timestamp: new Date().toISOString(),
          details: { count: docs.length, warnings: docWarnings },
        });

        const agent = await this.resolveAgent(options.agentName);
        const { output: epicOutput } = await this.invokeAgentWithRetry(
          agent,
          prompt,
          "epics",
          agentStream,
          job.id,
          commandRun.id,
          { docWarnings },
        );
        const epics = this.parseEpics(epicOutput, docs, options.projectKey).slice(
          0,
          options.maxEpics ?? Number.MAX_SAFE_INTEGER,
        );

        await this.jobService.writeCheckpoint(job.id, {
          stage: "epics_generated",
          timestamp: new Date().toISOString(),
          details: { epics: epics.length },
        });

        const plan = await this.generatePlanFromAgent(epics, agent, docSummary, {
          agentStream,
          jobId: job.id,
          commandRunId: commandRun.id,
          maxStoriesPerEpic: options.maxStoriesPerEpic,
          maxTasksPerStory: options.maxTasksPerStory,
        });

        await this.jobService.writeCheckpoint(job.id, {
          stage: "stories_generated",
          timestamp: new Date().toISOString(),
          details: { stories: plan.stories.length },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "tasks_generated",
          timestamp: new Date().toISOString(),
          details: { tasks: plan.tasks.length },
        });

        const { folder } = await this.writePlanArtifacts(options.projectKey, plan, docSummary);
        await this.jobService.writeCheckpoint(job.id, {
          stage: "plan_written",
          timestamp: new Date().toISOString(),
          details: { folder },
        });

        const { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows } =
        await this.persistPlanToDb(project.id, options.projectKey, plan, job.id, commandRun.id, {
          force: options.force,
          resetKeys: options.force,
        });

        await this.jobService.updateJobStatus(job.id, "completed", {
          payload: {
            epicsCreated: epicRows.length,
            storiesCreated: storyRows.length,
            tasksCreated: taskRows.length,
            dependenciesCreated: dependencyRows.length,
            docs: docSummary,
            planFolder: folder,
          },
        });
        await this.jobService.finishCommandRun(commandRun.id, "succeeded");

        return {
          jobId: job.id,
          commandRunId: commandRun.id,
          epics: epicRows,
          stories: storyRows,
          tasks: taskRows,
          dependencies: dependencyRows,
        };
      } catch (error) {
        lastError = error;
        const message = (error as Error).message;
        const isBusy =
          message?.includes("SQLITE_BUSY") ||
          message?.includes("database is locked") ||
          message?.includes("busy");
        const remaining = CreateTasksService.MAX_BUSY_RETRIES - attempt;
        if (isBusy && remaining > 0) {
          const backoff = CreateTasksService.BUSY_BACKOFF_MS * attempt;
          await this.jobService.appendLog(
            job.id,
            `Encountered SQLITE_BUSY, retrying create-tasks (attempt ${attempt}/${CreateTasksService.MAX_BUSY_RETRIES}) after ${backoff}ms...\n`,
          );
          await delay(backoff);
          continue;
        }
        await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
        await this.jobService.finishCommandRun(commandRun.id, "failed", message);
        throw error;
      }
    }
    await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: (lastError as Error)?.message });
    await this.jobService.finishCommandRun(commandRun.id, "failed", (lastError as Error)?.message);
    throw lastError ?? new Error("create-tasks failed");
  }

  async migratePlanFromFolder(options: {
    projectKey: string;
    planDir?: string;
    force?: boolean;
    refinePlanPath?: string;
    refinePlanPaths?: string[];
    refinePlansDir?: string;
  }): Promise<CreateTasksResult> {
    const projectKey = options.projectKey;
    const commandRun = await this.jobService.startCommandRun("migrate-tasks", projectKey);
    const job = await this.jobService.startJob("migrate_tasks", commandRun.id, projectKey, {
      commandName: "migrate-tasks",
      payload: { projectKey, planDir: options.planDir },
    });
    const planDir =
      options.planDir ?? path.join(this.workspace.workspaceRoot, ".mcoda", "tasks", projectKey);
    try {
      const planPath = path.join(planDir, "plan.json");
      const loadJson = async <T>(file: string): Promise<T | undefined> => {
        try {
          const raw = await fs.readFile(file, "utf8");
          return JSON.parse(raw) as T;
        } catch {
          return undefined;
        }
      };

      const planFromPlan = await loadJson<{ docSummary?: string } & GeneratedPlan>(planPath);
      const epicsFromFile = await loadJson<PlanEpic[]>(path.join(planDir, "epics.json"));
      const storiesFromFile = await loadJson<PlanStory[]>(path.join(planDir, "stories.json"));
      const tasksFromFile = await loadJson<PlanTask[]>(path.join(planDir, "tasks.json"));

      const epics = epicsFromFile ?? planFromPlan?.epics;
      const stories = storiesFromFile ?? planFromPlan?.stories;
      const tasks = tasksFromFile ?? planFromPlan?.tasks;
      const docSummary = planFromPlan?.docSummary;

      if (!epics || !stories || !tasks) {
        throw new Error(
          `Plan files missing required sections. Expected epics/stories/tasks in ${planDir} (plan.json or separate files).`,
        );
      }

      const project = await this.workspaceRepo.createProjectIfMissing({
        key: projectKey,
        name: projectKey,
        description: `Workspace project ${projectKey}`,
      });

      const plan: GeneratedPlan = {
        epics: epics as PlanEpic[],
        stories: stories as PlanStory[],
        tasks: tasks as PlanTask[],
      };

      const loadRefinePlans = async (): Promise<string[]> => {
        const candidates: string[] = [];
        if (options.refinePlanPath) candidates.push(options.refinePlanPath);
        if (options.refinePlanPaths && options.refinePlanPaths.length) candidates.push(...options.refinePlanPaths);
        if (options.refinePlansDir) {
          const dir = path.resolve(options.refinePlansDir);
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              candidates.push(path.join(dir, entry.name, "plan.json"));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
              candidates.push(path.join(dir, entry.name));
            }
          }
        }
        const uniq = Array.from(new Set(candidates.map((p) => path.resolve(p))));
        const existing: string[] = [];
        for (const file of uniq) {
          try {
            await fs.access(file);
            existing.push(file);
          } catch {
            // ignore missing file candidates (e.g., directory entries without plan.json)
          }
        }
        return existing.sort((a, b) => a.localeCompare(b));
      };

      const refinePlanPaths = await loadRefinePlans();

      // If refinement plans are provided, default to wiping existing backlog to avoid mixing old tasks.
      const forceBacklogReset = refinePlanPaths.length ? true : !!options.force;

      await this.jobService.writeCheckpoint(job.id, {
        stage: "plan_loaded",
        timestamp: new Date().toISOString(),
        details: { planDir, epics: plan.epics.length, stories: plan.stories.length, tasks: plan.tasks.length },
      });

      const { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows } =
        await this.persistPlanToDb(project.id, projectKey, plan, job.id, commandRun.id, {
          force: forceBacklogReset,
          resetKeys: forceBacklogReset,
        });

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          epicsCreated: epicRows.length,
          storiesCreated: storyRows.length,
          tasksCreated: taskRows.length,
          dependenciesCreated: dependencyRows.length,
          docs: docSummary,
          planFolder: planDir,
        },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");

      // Optionally apply a refinement plan from disk after seeding the backlog.
      if (refinePlanPaths.length > 0) {
        const { RefineTasksService } = await import("./RefineTasksService.js");
        const refineService = await RefineTasksService.create(this.workspace);
        try {
          for (const refinePlanPath of refinePlanPaths) {
            await refineService.refineTasks({
              workspace: this.workspace,
              projectKey,
              planInPath: path.resolve(refinePlanPath),
              fromDb: true,
              apply: true,
              agentStream: false,
              dryRun: false,
            });
          }
        } finally {
          await refineService.close();
        }
      }

      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        epics: epicRows,
        stories: storyRows,
        tasks: taskRows,
        dependencies: dependencyRows,
      };
    } catch (error) {
      const message = (error as Error).message;
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", message);
      throw error;
    }
  }
}
