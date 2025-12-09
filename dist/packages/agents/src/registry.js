import { openGlobalStore, } from "@mcoda/db/store.js";
export class AgentRegistry {
    constructor(store) {
        this.store = store;
    }
    static async create(options = {}) {
        const store = await openGlobalStore(options);
        return new AgentRegistry(store);
    }
    listAgents() {
        return this.store.listAgents();
    }
    getAgent(name, opts = {}) {
        return this.store.getAgent(name, opts);
    }
    addAgent(input) {
        return this.store.addAgent(input);
    }
    updateAgent(input) {
        return this.store.updateAgent(input);
    }
    deleteAgent(name) {
        this.store.deleteAgent(name);
    }
    setDefault(name) {
        return this.store.setDefault(name);
    }
    recordHealth(health) {
        this.store.recordAgentHealth(health);
    }
    getWorkspaceDefault(workspace) {
        return this.store.getWorkspaceDefault(workspace);
    }
    setWorkspaceDefault(workspace, agent, updatedAt) {
        this.store.setWorkspaceDefault(workspace, agent, updatedAt);
    }
    listRoutingRules(workspace) {
        return this.store.listRoutingRules(workspace);
    }
    setRoutingRule(rule) {
        this.store.upsertRoutingRule(rule);
    }
    deleteRoutingRule(workspace, command) {
        this.store.deleteRoutingRule(workspace, command);
    }
}
