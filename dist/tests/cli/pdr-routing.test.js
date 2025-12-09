import { describe, expect, it } from "vitest";
import { selectAgent } from "../../packages/cli/src/pdr-helpers.js";
const mkAgent = (name, opts = {}) => ({
    name,
    provider: "openai",
    model: "gpt-4o",
    default: false,
    hasAuth: true,
    capabilities: [],
    prompts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...opts,
});
describe("pdr agent selection", () => {
    const base = [mkAgent("alpha"), mkAgent("beta", { default: true })];
    it("prefers explicit --agent over defaults", () => {
        const { agent, reason } = selectAgent(base, { preferred: "alpha" });
        expect(agent.name).toBe("alpha");
        expect(reason).toContain("agent");
    });
    it("uses workspace rule before defaults", () => {
        const { agent, reason } = selectAgent(base, { workspaceRule: "alpha", workspaceDefault: "beta" });
        expect(agent.name).toBe("alpha");
        expect(reason).toContain("workspace routing rule");
    });
    it("falls back to default-flagged agent", () => {
        const { agent } = selectAgent(base, {});
        expect(agent.name).toBe("beta");
    });
});
