import type {
  McodaAgentSettingsSnapshot,
  McodaAgentSettingsStore,
} from "../types.js";

export function createInMemoryMcodaAgentSettingsStore(
  initial: Partial<McodaAgentSettingsSnapshot> = {}
): McodaAgentSettingsStore {
  let state: McodaAgentSettingsSnapshot = {
    assignments: { ...(initial.assignments ?? {}) },
    mswarmApiKeyConfigured: initial.mswarmApiKeyConfigured ?? false,
    mswarmApiKeyLast4: initial.mswarmApiKeyLast4 ?? null,
    mswarmConfiguredAt: initial.mswarmConfiguredAt ?? null,
    updatedAt: initial.updatedAt ?? null,
  };

  return {
    async load() {
      return {
        ...state,
        assignments: { ...state.assignments },
      };
    },
    async saveMswarmKeyMetadata(input) {
      const updatedAt = new Date().toISOString();
      state = {
        ...state,
        mswarmApiKeyConfigured: input.configured,
        mswarmApiKeyLast4: input.last4,
        mswarmConfiguredAt: input.configuredAt,
        updatedAt,
      };
    },
    async saveAssignments(input) {
      state = {
        ...state,
        assignments: { ...input.assignments },
        updatedAt: new Date().toISOString(),
      };
    },
  };
}
