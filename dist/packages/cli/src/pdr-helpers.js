export const selectAgent = (all, opts) => {
    const byName = (name) => (name ? all.find((a) => a.name === name) : undefined);
    if (!all.length)
        throw new Error("No agents found in the registry. Add one with `pnpm mcoda:agent -- add ...`.");
    const chain = [
        { cand: byName(opts.preferred), reason: `--agent ${opts.preferred}` },
        { cand: byName(opts.workspaceRule), reason: `workspace routing rule for command` },
        { cand: byName(opts.globalRule), reason: `global routing rule for command` },
        { cand: byName(opts.workspaceDefault), reason: `workspace default agent` },
        { cand: byName(opts.globalDefault), reason: `global default agent` },
        { cand: all.find((a) => a.default), reason: `agent flagged as default` },
        { cand: all[0], reason: `fallback to first agent` },
    ];
    const hit = chain.find((entry) => entry.cand !== undefined);
    if (!hit?.cand) {
        throw new Error("No agents found after applying routing/defaults.");
    }
    return { agent: hit.cand, reason: hit.reason };
};
