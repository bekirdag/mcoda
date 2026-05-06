import * as React from "react";
import { defaultMcodaStageDefinitions } from "../defaultStages.js";
import {
  filterAgentOptions,
  getVirtualAgentWindow,
} from "../headless/catalog.js";
import type {
  McodaAgentCatalogEntry,
  McodaAgentSetupClient,
  McodaAgentSetupSnapshot,
  McodaSelfHostedServer,
  McodaStageDefinition,
} from "../types.js";

export interface McodaAgentSetupPageProps {
  client: McodaAgentSetupClient;
  stages?: McodaStageDefinition[];
  title?: string;
  className?: string;
  labels?: Partial<McodaAgentSetupLabels>;
  components?: Partial<McodaAgentSetupComponentOverrides>;
}

export interface McodaAgentSetupLabels {
  saveKey: string;
  syncAgents: string;
  saveAssignments: string;
  cloud: string;
  selfHosted: string;
}

export interface McodaAgentSetupComponentOverrides {
  AgentCatalogSummary: typeof AgentCatalogSummary;
  MswarmAccessCard: typeof MswarmAccessCard;
  StageAgentAssignments: typeof StageAgentAssignments;
  AgentSourceSelect: typeof AgentSourceSelect;
  SelfHostedServerSelect: typeof SelfHostedServerSelect;
  AgentSearchSelect: typeof AgentSearchSelect;
}

const DEFAULT_LABELS: McodaAgentSetupLabels = {
  saveKey: "Save Key",
  syncAgents: "Sync Agents",
  saveAssignments: "Save Assignments",
  cloud: "Cloud",
  selfHosted: "Self-hosted",
};

export function McodaAgentSetupPage(
  props: McodaAgentSetupPageProps
): React.ReactElement {
  const labels = { ...DEFAULT_LABELS, ...(props.labels ?? {}) };
  const stages = props.stages ?? defaultMcodaStageDefinitions;
  const components = {
    AgentCatalogSummary,
    MswarmAccessCard,
    StageAgentAssignments,
    ...(props.components ?? {}),
  };
  const [snapshot, setSnapshot] =
    React.useState<McodaAgentSetupSnapshot | null>(null);
  const [assignments, setAssignments] = React.useState<Record<string, string | null>>(
    {}
  );
  const [apiKey, setApiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const next = await props.client.fetchSnapshot();
      setSnapshot(next);
      setAssignments(next.assignments);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [props.client]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const next = await props.client.configureMswarmApiKey({ apiKey });
      setApiKey("");
      setSnapshot(next);
      setAssignments(next.assignments);
      setStatusMessage("mswarm API key saved and agent catalogs synced.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const syncAgents = async () => {
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const next = await props.client.syncAgents();
      setSnapshot(next);
      setAssignments(next.assignments);
      setStatusMessage("Cloud and self-hosted agent catalogs synced.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveAssignments = async () => {
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const next = await props.client.updateAssignments({ assignments });
      setSnapshot(next);
      setAssignments(next.assignments);
      setStatusMessage("Stage assignments saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return React.createElement(
    "section",
    { className: joinClasses("mcoda-agent-setup", props.className) },
    React.createElement(
      "header",
      { className: "mcoda-agent-setup__header" },
      React.createElement(
        "div",
        { className: "mcoda-agent-setup__title-block" },
        React.createElement("p", { className: "mcoda-agent-setup__eyebrow" }, "Runtime routing"),
        React.createElement("h1", null, props.title ?? "mcoda Agent Setup"),
        React.createElement(
          "p",
          null,
          "Configure mswarm access and assign cloud or self-hosted mcoda agents to each runtime stage."
        )
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "mcoda-agent-setup__button mcoda-agent-setup__button--secondary",
          disabled: busy,
          onClick: refresh,
        },
        busy ? "Refreshing" : "Refresh"
      )
    ),
    error
      ? React.createElement("p", { className: "mcoda-agent-setup__alert mcoda-agent-setup__alert--error" }, error)
      : null,
    statusMessage
      ? React.createElement(
          "p",
          { className: "mcoda-agent-setup__alert mcoda-agent-setup__alert--success" },
          statusMessage
        )
      : null,
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__overview" },
      snapshot
        ? React.createElement(components.AgentCatalogSummary, { snapshot })
        : React.createElement(
            "div",
            { className: "mcoda-agent-setup__empty-state" },
            busy ? "Loading settings." : "No settings loaded."
          ),
      React.createElement(components.MswarmAccessCard, {
        apiKey,
        busy,
        labels,
        snapshot,
        onApiKeyChange: setApiKey,
        onSaveKey: saveKey,
        onSyncAgents: syncAgents,
      })
    ),
    snapshot
      ? React.createElement(components.StageAgentAssignments, {
          stages,
          snapshot,
          assignments,
          labels,
          onAssignmentChange: (stageKey, slug) =>
            setAssignments((current) => ({ ...current, [stageKey]: slug })),
          onSaveAssignments: saveAssignments,
          busy,
        })
      : null
  );
}

export function AgentCatalogSummary(props: {
  snapshot: McodaAgentSetupSnapshot;
}): React.ReactElement {
  const { snapshot } = props;
  const warningEntries = Object.entries(snapshot.catalog.errors);
  return React.createElement(
    "section",
    { className: "mcoda-agent-setup__summary" },
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__card-heading" },
      React.createElement("div", null,
        React.createElement("h2", null, "Catalog Snapshot"),
        React.createElement("p", null, `Fetched ${formatTimestamp(snapshot.fetchedAt)}`)
      ),
      React.createElement(
        "span",
        {
          className: snapshot.mswarmApiKeyConfigured
            ? "mcoda-agent-setup__badge mcoda-agent-setup__badge--success"
            : "mcoda-agent-setup__badge mcoda-agent-setup__badge--warning",
        },
        snapshot.mswarmApiKeyConfigured ? "Configured" : "Missing key"
      )
    ),
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__metric-grid" },
      React.createElement(MetricCard, {
        label: "Provider",
        value: snapshot.provider,
        detail: "active runtime",
      }),
      React.createElement(MetricCard, {
        label: "mswarm key",
        value: snapshot.mswarmApiKeyLast4
          ? `****${snapshot.mswarmApiKeyLast4}`
          : snapshot.mswarmApiKeyConfigured
            ? "Configured"
            : "Missing",
        detail: `set ${formatTimestamp(snapshot.mswarmConfiguredAt)}`,
      }),
      React.createElement(MetricCard, {
        label: "Synced agents",
        value: String(snapshot.catalog.localAgents.length),
        detail: "mcoda registry entries",
      }),
      React.createElement(MetricCard, {
        label: "Cloud agents",
        value: String(snapshot.catalog.cloudAgents.length),
        detail: "mswarm cloud catalog",
      }),
      React.createElement(MetricCard, {
        label: "Self-hosted",
        value: String(snapshot.catalog.selfHostedAgents.length),
        detail: `${snapshot.catalog.selfHostedServers.length} servers`,
      })
    ),
    warningEntries.length
      ? React.createElement(
          "ul",
          { className: "mcoda-agent-setup__warnings", "aria-label": "Catalog warnings" },
          warningEntries.map(([key, value]) =>
            React.createElement("li", { key }, `${key}: ${value}`)
          )
        )
      : null
  );
}

export function MswarmAccessCard(props: {
  apiKey: string;
  busy?: boolean;
  labels?: Partial<McodaAgentSetupLabels>;
  snapshot?: McodaAgentSetupSnapshot | null;
  onApiKeyChange: (value: string) => void;
  onSaveKey: () => void;
  onSyncAgents: () => void;
}): React.ReactElement {
  const labels = { ...DEFAULT_LABELS, ...(props.labels ?? {}) };
  return React.createElement(
    "section",
    { className: "mcoda-agent-setup__access" },
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__card-heading" },
      React.createElement("div", null,
        React.createElement("h2", null, "mswarm Access"),
        React.createElement(
          "p",
          null,
          props.snapshot?.mswarmApiKeyConfigured
            ? "Replace the stored key or resync the catalog."
            : "Add a key to load real cloud and self-hosted agents."
        )
      )
    ),
    React.createElement(
      "label",
      { className: "mcoda-agent-setup__field" },
      React.createElement("span", null, "API key"),
      React.createElement("input", {
        type: "password",
        value: props.apiKey,
        autoComplete: "off",
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          props.onApiKeyChange(event.target.value),
        placeholder: props.snapshot?.mswarmApiKeyConfigured
          ? "Replace mswarm API key"
          : "sk_prod_mswarm_...",
      })
    ),
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__action-row" },
      React.createElement(
        "button",
        {
          type: "button",
          className: "mcoda-agent-setup__button mcoda-agent-setup__button--primary",
          disabled: props.busy || !props.apiKey.trim(),
          onClick: props.onSaveKey,
        },
        labels.saveKey
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "mcoda-agent-setup__button mcoda-agent-setup__button--secondary",
          disabled: props.busy,
          onClick: props.onSyncAgents,
        },
        labels.syncAgents
      )
    )
  );
}

export function StageAgentAssignments(props: {
  stages: McodaStageDefinition[];
  snapshot: McodaAgentSetupSnapshot;
  assignments: Record<string, string | null>;
  labels?: Partial<McodaAgentSetupLabels>;
  busy?: boolean;
  onAssignmentChange: (stageKey: string, slug: string | null) => void;
  onSaveAssignments: () => void;
}): React.ReactElement {
  const labels = { ...DEFAULT_LABELS, ...(props.labels ?? {}) };
  const sourceSelect = AgentSourceSelect;
  const serverSelect = SelfHostedServerSelect;
  const agentSelect = AgentSearchSelect;
  const [sources, setSources] = React.useState<Record<string, "cloud" | "self_hosted">>(
    {}
  );
  const [servers, setServers] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    const nextSources: Record<string, "cloud" | "self_hosted"> = {};
    const nextServers: Record<string, string> = {};
    for (const stage of props.stages) {
      const assignment = props.assignments[stage.stageKey];
      if (!assignment) continue;
      const selfHostedServer = props.snapshot.catalog.selfHostedServers.find((server) =>
        server.agents.some((agent) => agent.slug === assignment)
      );
      if (selfHostedServer) {
        nextSources[stage.stageKey] = "self_hosted";
        nextServers[stage.stageKey] = selfHostedServer.id;
        continue;
      }
      if (props.snapshot.catalog.cloudAgents.some((agent) => agent.slug === assignment)) {
        nextSources[stage.stageKey] = "cloud";
      }
    }
    setSources((current) => ({ ...current, ...nextSources }));
    setServers((current) => ({ ...current, ...nextServers }));
  }, [props.assignments, props.snapshot.catalog.cloudAgents, props.snapshot.catalog.selfHostedServers, props.stages]);

  return React.createElement(
    "section",
    { className: "mcoda-agent-setup__assignments" },
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__card-heading" },
      React.createElement("div", null,
        React.createElement("h2", null, "Stage Assignments"),
        React.createElement("p", null, "Select the agent that should run each app workflow stage.")
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "mcoda-agent-setup__button mcoda-agent-setup__button--success",
          disabled: props.busy,
          onClick: props.onSaveAssignments,
        },
        labels.saveAssignments
      )
    ),
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__stage-table-wrap" },
      React.createElement(
        "table",
        { className: "mcoda-agent-setup__stage-table" },
        React.createElement(
          "thead",
          null,
          React.createElement(
            "tr",
            null,
            React.createElement("th", null, "Stage"),
            React.createElement("th", null, "Source"),
            React.createElement("th", null, "Self-hosted server"),
            React.createElement("th", null, "Agent"),
            React.createElement("th", null, "Status")
          )
        ),
        React.createElement(
          "tbody",
          null,
          props.stages.map((stage) => {
            const selectedSlug = props.assignments[stage.stageKey] ?? "";
            const source =
              sources[stage.stageKey] ??
              (stage.preferredSource === "self_hosted" ? "self_hosted" : "cloud");
            const serverId = servers[stage.stageKey];
            const server =
              props.snapshot.catalog.selfHostedServers.find(
                (candidate) => candidate.id === serverId
              ) ?? props.snapshot.catalog.selfHostedServers[0];
            const agents =
              source === "cloud"
                ? props.snapshot.catalog.cloudAgents
                : server?.agents ?? [];
            const allSelectableAgents = [
              ...props.snapshot.catalog.cloudAgents,
              ...props.snapshot.catalog.selfHostedServers.flatMap(
                (candidate) => candidate.agents
              ),
            ];
            const selectedAgent = allSelectableAgents.find(
              (agent) => agent.slug === selectedSlug
            );
            const agentSelectValue = agents.some(
              (agent) => agent.slug === selectedSlug
            )
              ? selectedSlug
              : "";
            const onSourceChange = (value: "cloud" | "self_hosted") => {
              setSources((current) => ({ ...current, [stage.stageKey]: value }));
              const nextSlug =
                value === "cloud"
                  ? props.snapshot.catalog.cloudAgents[0]?.slug
                  : firstSelfHostedAgentSlug(props.snapshot.catalog.selfHostedServers);
              props.onAssignmentChange(stage.stageKey, nextSlug ?? null);
            };
            const onServerChange = (value: string) => {
              setServers((current) => ({ ...current, [stage.stageKey]: value }));
              const nextServer = props.snapshot.catalog.selfHostedServers.find(
                (candidate) => candidate.id === value
              );
              props.onAssignmentChange(
                stage.stageKey,
                nextServer?.agents[0]?.slug ?? null
              );
            };
            return React.createElement(
              "tr",
              { key: stage.stageKey },
              React.createElement(
                "td",
                { className: "mcoda-agent-setup__stage-cell" },
                React.createElement("strong", null, stage.displayName),
                stage.description
                  ? React.createElement("p", null, stage.description)
                  : null,
                React.createElement("code", null, stage.stageKey)
              ),
              React.createElement(
                "td",
                null,
                React.createElement(sourceSelect, {
                  value: source,
                  labels,
                  onChange: onSourceChange,
                })
              ),
              React.createElement(
                "td",
                null,
                source === "self_hosted"
                  ? React.createElement(serverSelect, {
                      servers: props.snapshot.catalog.selfHostedServers,
                      value: server?.id ?? "",
                      onChange: onServerChange,
                    })
                  : React.createElement(
                      "span",
                      { className: "mcoda-agent-setup__muted-pill" },
                      "Cloud catalog"
                    )
              ),
              React.createElement(
                "td",
                null,
                React.createElement(agentSelect, {
                  agents,
                  value: agentSelectValue,
                  onChange: (slug) =>
                    props.onAssignmentChange(stage.stageKey, slug || null),
                })
              ),
              React.createElement(
                "td",
                null,
                React.createElement(AgentStatusBadge, {
                  agent: selectedAgent,
                  slug: selectedSlug,
                })
              )
            );
          })
        )
      )
    )
  );
}

export function AgentSourceSelect(props: {
  value: "cloud" | "self_hosted";
  labels?: Partial<McodaAgentSetupLabels>;
  onChange: (value: "cloud" | "self_hosted") => void;
}): React.ReactElement {
  const labels = { ...DEFAULT_LABELS, ...(props.labels ?? {}) };
  return React.createElement(
    "div",
    { className: "mcoda-agent-setup__source", role: "group", "aria-label": "Agent source" },
    React.createElement(
      "button",
      {
        type: "button",
        "aria-pressed": props.value === "cloud",
        onClick: () => props.onChange("cloud"),
      },
      labels.cloud
    ),
    React.createElement(
      "button",
      {
        type: "button",
        "aria-pressed": props.value === "self_hosted",
        onClick: () => props.onChange("self_hosted"),
      },
      labels.selfHosted
    )
  );
}

export function SelfHostedServerSelect(props: {
  servers: McodaSelfHostedServer[];
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const filteredServers =
    props.servers.length > 8 && query.trim()
      ? props.servers.filter((server) =>
          [server.label, server.id, server.nodeId, server.serverName, server.remoteSlugPrefix]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query.trim().toLowerCase())
        )
      : props.servers;
  return React.createElement(
    "div",
    { className: "mcoda-agent-setup__server-select" },
    props.servers.length > 8
      ? React.createElement("input", {
          value: query,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            setQuery(event.target.value),
          placeholder: "Search server",
        })
      : null,
    React.createElement(
      "select",
      {
        value: props.value,
        disabled: filteredServers.length === 0,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          props.onChange(event.target.value),
      },
      React.createElement(
        "option",
        { value: "" },
        filteredServers.length ? "Select server" : "No servers synced"
      ),
      filteredServers.map((server) =>
        React.createElement(
          "option",
          { key: server.id, value: server.id },
          `${server.label} (${server.agentCount})`
        )
      )
    )
  );
}

export function AgentSearchSelect(props: {
  agents: McodaAgentCatalogEntry[];
  value: string;
  onChange: (value: string) => void;
  rowHeight?: number;
  viewportHeight?: number;
}): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [scrollTop, setScrollTop] = React.useState(0);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const [panelFrame, setPanelFrame] = React.useState({
    left: 0,
    maxHeight: 420,
    top: 0,
    width: 360,
  });
  const filtered = React.useMemo(
    () => filterAgentOptions(props.agents, query),
    [props.agents, query]
  );
  const rowHeight = props.rowHeight ?? 64;
  const viewportHeight = Math.min(props.viewportHeight ?? 320, panelFrame.maxHeight - 74);
  const windowed = getVirtualAgentWindow(filtered, {
    scrollTop,
    rowHeight,
    viewportHeight,
  });
  const selected = props.agents.find((agent) => agent.slug === props.value);
  React.useEffect(() => {
    setActiveIndex(0);
    setScrollTop(0);
  }, [query, props.agents]);

  React.useEffect(() => {
    if (!open) return;
    const updatePanelFrame = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(
        Math.max(rect.width, 380),
        Math.max(280, viewportWidth - 16)
      );
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, viewportWidth - width - 8)
      );
      const spaceBelow = viewportHeight - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const openBelow = spaceBelow >= 280 || spaceBelow >= spaceAbove;
      const maxHeight = Math.min(420, Math.max(openBelow ? spaceBelow : spaceAbove, 180));
      const top = openBelow
        ? Math.min(rect.bottom + 6, viewportHeight - maxHeight - 8)
        : Math.max(8, rect.top - maxHeight - 6);
      setPanelFrame({ left, maxHeight, top, width });
    };

    updatePanelFrame();
    searchRef.current?.focus();
    window.addEventListener("resize", updatePanelFrame);
    window.addEventListener("scroll", updatePanelFrame, true);
    return () => {
      window.removeEventListener("resize", updatePanelFrame);
      window.removeEventListener("scroll", updatePanelFrame, true);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const selectAgent = (agent: McodaAgentCatalogEntry) => {
    props.onChange(agent.slug);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLDivElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      setQuery("");
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(filtered.length - 1, current + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === "Enter" && filtered[activeIndex]) {
      event.preventDefault();
      selectAgent(filtered[activeIndex]);
    }
  };
  return React.createElement(
    "div",
    { className: "mcoda-agent-setup__agent-combobox" },
    React.createElement(
      "button",
      {
        ref: triggerRef,
        type: "button",
        className: "mcoda-agent-setup__agent-trigger",
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        disabled: props.agents.length === 0,
        onClick: () => setOpen((current) => !current),
      },
      React.createElement(
        "span",
        { className: "mcoda-agent-setup__agent-trigger-main" },
        selected
          ? React.createElement(React.Fragment, null,
              React.createElement("strong", null, agentTitle(selected)),
              React.createElement("small", null, agentMetadata(selected))
            )
          : React.createElement("strong", null, props.agents.length ? "Select agent" : "No agents synced")
      ),
      React.createElement("span", { className: "mcoda-agent-setup__chevron" }, "⌄")
    ),
    open
      ? React.createElement(
          "div",
          {
            className: "mcoda-agent-setup__agent-panel",
            ref: panelRef,
            style: {
              left: panelFrame.left,
              maxHeight: panelFrame.maxHeight,
              top: panelFrame.top,
              width: panelFrame.width,
            },
          },
          React.createElement(
            "div",
            { className: "mcoda-agent-setup__agent-panel-search" },
            React.createElement("input", {
              ref: searchRef,
              value: query,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                setQuery(event.target.value),
              onKeyDown,
              "aria-label": "Search agents",
              placeholder: "Search agent, model, provider, or slug",
            })
          ),
          React.createElement(
            "div",
            { className: "mcoda-agent-setup__agent-count" },
            filtered.length
              ? `Showing all ${filtered.length} agents`
              : "No agents match this search"
          ),
          React.createElement(
            "div",
            {
              className: "mcoda-agent-setup__agent-list",
              role: "listbox",
              style: { maxHeight: viewportHeight, overflowY: "auto" },
              onKeyDown,
              onScroll: (event: React.UIEvent<HTMLDivElement>) =>
                setScrollTop(event.currentTarget.scrollTop),
            },
            React.createElement("div", { style: { height: windowed.beforeHeight } }),
            windowed.items.map((agent, index) => {
              const absoluteIndex = windowed.startIndex + index;
              const active = absoluteIndex === activeIndex;
              return React.createElement(
                "button",
                {
                  key: agent.slug,
                  type: "button",
                  className:
                    agent.slug === props.value || active
                      ? "mcoda-agent-setup__agent-row mcoda-agent-setup__agent-row--selected"
                      : "mcoda-agent-setup__agent-row",
                  role: "option",
                  "aria-selected": agent.slug === props.value,
                  style: { minHeight: rowHeight },
                  onMouseEnter: () => setActiveIndex(absoluteIndex),
                  onClick: () => selectAgent(agent),
                },
                React.createElement(
                  "span",
                  { className: "mcoda-agent-setup__agent-row-main" },
                  React.createElement("strong", null, agentTitle(agent)),
                  React.createElement("small", null, agentMetadata(agent)),
                  React.createElement("code", null, agent.slug)
                ),
                agent.slug === props.value
                  ? React.createElement(
                      "span",
                      { className: "mcoda-agent-setup__selected-mark" },
                      "Selected"
                    )
                  : null
              );
            }),
            React.createElement("div", { style: { height: windowed.afterHeight } })
          )
        )
      : null
  );
}

function MetricCard(props: {
  label: string;
  value: string;
  detail: string;
}): React.ReactElement {
  return React.createElement(
    "div",
    { className: "mcoda-agent-setup__metric" },
    React.createElement("span", null, props.label),
    React.createElement("strong", null, props.value),
    React.createElement("small", null, props.detail)
  );
}

function AgentStatusBadge(props: {
  agent: McodaAgentCatalogEntry | undefined;
  slug: string;
}): React.ReactElement {
  const kind = props.agent?.managedKind;
  const sourceLabel =
    kind === "cloud"
      ? "Cloud"
      : kind === "self_hosted"
        ? "Self-hosted"
        : props.agent
          ? "Local"
          : props.slug
            ? "Missing"
            : "Unset";
  const className =
    kind === "cloud"
      ? "mcoda-agent-setup__badge mcoda-agent-setup__badge--info"
      : kind === "self_hosted"
        ? "mcoda-agent-setup__badge mcoda-agent-setup__badge--success"
        : props.agent
          ? "mcoda-agent-setup__badge"
          : "mcoda-agent-setup__badge mcoda-agent-setup__badge--warning";
  return React.createElement("span", { className }, sourceLabel);
}

function firstSelfHostedAgentSlug(servers: McodaSelfHostedServer[]): string | null {
  return servers.find((server) => server.agents.length > 0)?.agents[0]?.slug ?? null;
}

function agentTitle(agent: McodaAgentCatalogEntry): string {
  return agent.displayName ?? prettySlug(agent.slug);
}

function agentMetadata(agent: McodaAgentCatalogEntry): string {
  return (
    [
      agent.defaultModel ?? agent.model,
      agent.provider,
      agent.healthStatus && agent.healthStatus !== "-" ? agent.healthStatus : null,
    ]
      .filter(Boolean)
      .join(" / ") || agent.slug
  );
}

function prettySlug(slug: string): string {
  return slug
    .replace(/^mswarm-cloud-/, "")
    .replace(/^mswarm-self-hosted-/, "")
    .replace(/^mcoda-/, "")
    .replace(/[-_]+/g, " ");
}

function formatTimestamp(value: string | null): string {
  if (!value) return "never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const deltaMinutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (deltaMinutes < 1) return "just now";
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  return `${Math.round(deltaHours / 24)}d ago`;
}

function joinClasses(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export { createMcodaAgentSetupClient } from "../client.js";
export { defaultMcodaStageDefinitions } from "../defaultStages.js";
export type * from "../types.js";
