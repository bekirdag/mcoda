import type {
  Provider,
  ProviderMessage,
  ProviderResponseFormat,
} from "../providers/ProviderTypes.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import type { ContextBundle, Plan } from "./Types.js";
import { ARCHITECT_PROMPT } from "./Prompts.js";
import type { ContextManager } from "./ContextManager.js";

const buildUserMessage = (context: ContextBundle): ProviderMessage => ({
  role: "user",
  content: context.serialized?.content ?? JSON.stringify(context, null, 2),
});

const assertPlan = (plan: unknown): Plan => {
  if (!plan || typeof plan !== "object") {
    throw new Error("Plan output is not an object");
  }
  const record = plan as Record<string, unknown>;
  const steps = Array.isArray(record.steps)
    ? record.steps
    : Array.isArray(record.plan)
      ? record.plan
      : undefined;
  const targetFiles = Array.isArray(record.target_files)
    ? record.target_files
    : Array.isArray(record.filesLikelyTouched)
      ? record.filesLikelyTouched
      : Array.isArray(record.files)
        ? record.files
        : undefined;
  const riskAssessment =
    typeof record.risk_assessment === "string"
      ? record.risk_assessment
      : typeof record.risk === "string"
        ? record.risk
        : undefined;
  const risks = Array.isArray(record.risks)
    ? record.risks.filter((item) => typeof item === "string")
    : undefined;
  const risk = riskAssessment ?? (risks && risks.length ? risks.join("; ") : undefined);
  const verification = Array.isArray(record.verification)
    ? record.verification
    : Array.isArray(record.tests)
      ? record.tests
      : undefined;

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("Plan missing steps (expected steps or plan array)");
  }
  if (!Array.isArray(targetFiles) || targetFiles.length === 0) {
    throw new Error("Plan missing target_files (expected target_files or filesLikelyTouched)");
  }
  if (typeof risk !== "string" || risk.length === 0) {
    throw new Error("Plan missing risk_assessment");
  }
  if (!Array.isArray(verification)) {
    throw new Error("Plan missing verification");
  }

  return {
    steps: steps as string[],
    target_files: targetFiles as string[],
    risk_assessment: risk,
    verification: verification as string[],
  };
};

export interface ArchitectPlannerOptions {
  temperature?: number;
  logger?: RunLogger;
  contextManager?: ContextManager;
  laneId?: string;
  model?: string;
  responseFormat?: ProviderResponseFormat;
}

export class ArchitectPlanner {
  private temperature?: number;
  private logger?: RunLogger;
  private contextManager?: ContextManager;
  private laneId?: string;
  private model?: string;
  private responseFormat?: ProviderResponseFormat;

  constructor(private provider: Provider, options: ArchitectPlannerOptions = {}) {
    this.temperature = options.temperature;
    this.logger = options.logger;
    this.contextManager = options.contextManager;
    this.laneId = options.laneId;
    this.model = options.model;
    this.responseFormat = options.responseFormat;
  }

  async plan(
    context: ContextBundle,
    options: {
      contextManager?: ContextManager;
      laneId?: string;
      model?: string;
      responseFormat?: ProviderResponseFormat;
    } = {},
  ): Promise<Plan> {
    const contextManager = options.contextManager ?? this.contextManager;
    const laneId = options.laneId ?? this.laneId;
    const model = options.model ?? this.model;
    const responseFormat =
      options.responseFormat ?? this.responseFormat ?? { type: "json" };
    const systemMessage: ProviderMessage = { role: "system", content: ARCHITECT_PROMPT };
    const userMessage = buildUserMessage(context);
    const history =
      contextManager && laneId
        ? await contextManager.prepare(laneId, {
            systemPrompt: systemMessage.content,
            bundle: userMessage.content,
            model,
          })
        : [];
    const response = await this.provider.generate({
      messages: [
        systemMessage,
        ...history,
        userMessage,
      ],
      responseFormat,
      temperature: this.temperature,
    });

    if (response.usage && this.logger) {
      await this.logger.log("phase_usage", { phase: "architect", usage: response.usage });
    }

    const content = response.message.content?.trim() ?? "";
    if (!content) {
      throw new Error("Architect response is empty");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error("Architect response is not valid JSON");
    }
    const plan = assertPlan(parsed);

    if (contextManager && laneId) {
      await contextManager.append(laneId, userMessage, { role: "architect", model });
      await contextManager.append(laneId, response.message, {
        role: "architect",
        model,
        tokens: response.usage?.totalTokens,
      });
    }

    return plan;
  }
}
