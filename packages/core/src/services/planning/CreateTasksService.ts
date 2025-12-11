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

const formatBullets = (items: string[] | undefined, fallback: string): string => {
  if (!items || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
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
    "- Unit/integration coverage for changed areas.",
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
      "relatedDocs": ["docdex:..."]
    }
  ]
}`;

export class CreateTasksService {
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
    if ((this.agentService as any).close) await this.agentService.close();
    if ((this.repo as any).close) await this.repo.close();
    if ((this.jobService as any).close) await this.jobService.close();
    if ((this.workspaceRepo as any).close) await this.workspaceRepo.close();
    if ((this.routingService as any).close) await this.routingService.close();
    const docdex = this.docdex as any;
    if (docdex?.close) await docdex.close();
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
    const prompt = [
      `Generate tasks for story "${story.title}" (Epic: ${epic.title}).`,
      "Use the Task template: Objective; Context; Inputs; Implementation Plan; DoD; Testing & QA; Dependencies; Risks; References.",
      "Return JSON only matching:",
      TASK_SCHEMA_SNIPPET,
      "Rules:",
      "- Each task must include localId, title, description, type, estimatedStoryPoints, priorityHint.",
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
      }))
      .filter((t: AgentTaskNode) => t.title);
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

      const existingEpicKeys = await this.workspaceRepo.listEpicKeys(project.id);
      const epicKeyGen = createEpicKeyGenerator(options.projectKey, existingEpicKeys);

      const epicInserts: EpicInsert[] = [];
      const epicMeta: { key: string; node: AgentEpicNode & { key?: string } }[] = [];

      for (const epic of epics) {
        const key = epicKeyGen(epic.area);
        epicInserts.push({
          projectId: project.id,
          key,
          title: epic.title || `Epic ${key}`,
          description: buildEpicDescription(key, epic.title || `Epic ${key}`, epic.description, epic.acceptanceCriteria, epic.relatedDocs),
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
        epicRows = await this.workspaceRepo.insertEpics(epicInserts, false);

        const storyInserts: StoryInsert[] = [];
        const storyMeta: { storyKey: string; epicKey: string; node: AgentStoryNode }[] = [];
        for (const epic of epicMeta) {
          const epicRow = epicRows.find((row) => row.key === epic.key);
          if (!epicRow) continue;
          epic.node.key = epicRow.key;
          const stories = await this.generateStoriesForEpic(
            agent,
            { ...epic.node, key: epicRow.key },
            docSummary,
            agentStream,
            job.id,
            commandRun.id,
          );
          await this.jobService.writeCheckpoint(job.id, {
            stage: "stories_generated",
            timestamp: new Date().toISOString(),
            details: { epicKey: epicRow.key, stories: stories.length },
          });
          const existingStoryKeys = await this.workspaceRepo.listStoryKeys(epicRow.id);
          const storyKeyGen = createStoryKeyGenerator(epicRow.key, existingStoryKeys);
          for (const story of stories.slice(0, options.maxStoriesPerEpic ?? stories.length)) {
            const storyKey = storyKeyGen();
            storyInserts.push({
              projectId: project.id,
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

        type TaskDetail = { localId: string; key: string; storyKey: string; epicKey: string; plan: AgentTaskNode };
        const taskDetails: TaskDetail[] = [];
        for (const story of storyMeta) {
          const storyId = storyIdByKey.get(story.storyKey);
          const existingTaskKeys = storyId ? await this.workspaceRepo.listTaskKeys(storyId) : [];
          const tasks = await this.generateTasksForStory(
            agent,
            { key: story.epicKey, title: epicRows.find((e) => e.key === story.epicKey)?.title ?? story.epicKey },
            story.node,
            docSummary,
            agentStream,
            job.id,
            commandRun.id,
          );
          await this.jobService.writeCheckpoint(job.id, {
            stage: "tasks_generated",
            timestamp: new Date().toISOString(),
            details: { storyKey: story.storyKey, tasks: tasks.length },
          });
          const limitedTasks = tasks.slice(0, options.maxTasksPerStory ?? tasks.length);
          const taskKeyGen = createTaskKeyGenerator(story.storyKey, existingTaskKeys);
          for (const task of limitedTasks) {
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
            projectId: project.id,
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
            ),
            type: task.plan.type ?? "feature",
            status: "not_started",
            storyPoints: task.plan.estimatedStoryPoints ?? null,
            priority: task.plan.priorityHint ?? (taskInserts.length + 1),
            metadata: task.plan.relatedDocs ? { doc_links: task.plan.relatedDocs } : undefined,
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

        const dependencies: TaskDependencyInsert[] = [];
        for (const detail of taskDetails) {
          const current = taskByLocal.get(detail.localId);
          if (!current) continue;
          for (const dep of detail.plan.dependsOnKeys ?? []) {
            const target = taskByLocal.get(dep);
            if (target && target.id !== current.id) {
              dependencies.push({
                taskId: current.id,
                dependsOnTaskId: target.id,
                relationType: "blocks",
              });
            }
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
            jobId: job.id,
            commandRunId: commandRun.id,
            startedAt: now,
            finishedAt: now,
            runContext: { key: task.key },
          });
        }
      });

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          epicsCreated: epicRows.length,
          storiesCreated: storyRows.length,
          tasksCreated: taskRows.length,
          dependenciesCreated: dependencyRows.length,
          docs: docSummary,
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
      const message = (error as Error).message;
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", message);
      throw error;
    }
  }
}
