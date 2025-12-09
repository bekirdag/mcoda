import { openWorkspaceStore } from "@mcoda/db/store.js";
import { AgentRegistry } from "@mcoda/agents/registry.js";
export { resolveWorkspaceContext } from "@mcoda/db/workspace.js";
export { getGlobalLayout, getWorkspaceLayout } from "@mcoda/db/migration.js";
export const createWorkspaceService = async (options = {}) => {
    return openWorkspaceStore(options);
};
export const createAgentService = async (options = {}) => {
    return AgentRegistry.create(options);
};
