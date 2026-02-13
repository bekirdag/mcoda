import type { ProviderConfig, ProviderResponseFormat } from "../providers/ProviderTypes.js";
import type { RoutingConfig, RoutingPhaseConfig } from "../config/Config.js";

export type PipelinePhase = "librarian" | "architect" | "builder" | "critic" | "interpreter";

export interface ProviderDefaults {
  provider: string;
  config: ProviderConfig;
}

export interface RoutedProvider {
  provider: string;
  config: ProviderConfig;
  temperature?: number;
  responseFormat?: ProviderResponseFormat;
}

const toResponseFormat = (
  format?: string,
  grammar?: string,
): ProviderResponseFormat | undefined => {
  if (!format) return undefined;
  if (format === "json") {
    return { type: "json" };
  }
  if ((format === "gbnf" || format === "grammar") && grammar) {
    return { type: "gbnf", grammar };
  }
  return undefined;
};

export const resolvePhaseRouting = (
  routing: RoutingConfig | undefined,
  phase: PipelinePhase,
): RoutingPhaseConfig | undefined => routing?.[phase];

export const buildRoutedProvider = (
  phase: PipelinePhase,
  defaults: ProviderDefaults,
  routing?: RoutingConfig,
  lockProviderModel = false,
): RoutedProvider => {
  const phaseConfig = resolvePhaseRouting(routing, phase);
  return {
    provider: lockProviderModel ? defaults.provider : phaseConfig?.provider ?? defaults.provider,
    config: {
      ...defaults.config,
      model: lockProviderModel ? defaults.config.model : phaseConfig?.model ?? defaults.config.model,
    },
    temperature: phaseConfig?.temperature,
    responseFormat: toResponseFormat(phaseConfig?.format, phaseConfig?.grammar),
  };
};
