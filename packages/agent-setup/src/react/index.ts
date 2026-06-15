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
  McodaGpuJobOpsPanelData,
  McodaGpuJobOpsPanelJob,
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
  gpuJobOps?: McodaGpuJobOpsPanelData | null;
  onGpuJobOpsRefresh?: () => void | Promise<void>;
  onGpuJobViewDetails?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
  onGpuJobViewLogs?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
  onGpuJobViewArtifacts?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
  onGpuJobRetry?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
  onGpuJobCancel?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
}

export interface McodaAgentSetupLabels {
  saveKey: string;
  syncAgents: string;
  saveAssignments: string;
  local: string;
  cloud: string;
  selfHosted: string;
  workers: string;
}

export interface McodaAgentSetupComponentOverrides {
  AgentCatalogSummary: typeof AgentCatalogSummary;
  MswarmAccessCard: typeof MswarmAccessCard;
  GpuJobOpsPanel: typeof GpuJobOpsPanel;
  StageAgentAssignments: typeof StageAgentAssignments;
  AgentSourceSelect: typeof AgentSourceSelect;
  SelfHostedServerSelect: typeof SelfHostedServerSelect;
  AgentSearchSelect: typeof AgentSearchSelect;
}

const DEFAULT_LABELS: McodaAgentSetupLabels = {
  saveKey: "Save Key",
  syncAgents: "Sync Agents",
  saveAssignments: "Save Assignments",
  local: "Local",
  cloud: "Cloud",
  selfHosted: "Self-hosted",
  workers: "Workers",
};

type AgentAssignmentSource = "local" | "cloud" | "self_hosted" | "worker";

export function McodaAgentSetupPage(
  props: McodaAgentSetupPageProps
): React.ReactElement {
  const labels = { ...DEFAULT_LABELS, ...(props.labels ?? {}) };
  const stages = props.stages ?? defaultMcodaStageDefinitions;
  const components = {
    AgentCatalogSummary,
    MswarmAccessCard,
    GpuJobOpsPanel,
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
      setStatusMessage("Cloud, self-hosted, and Worker agent catalogs synced.");
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
  const refreshGpuJobOps = async () => {
    if (!props.onGpuJobOpsRefresh) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      await props.onGpuJobOpsRefresh();
      setStatusMessage("GPU job operations refreshed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const runGpuJobAction = async (
    action: ((job: McodaGpuJobOpsPanelJob) => void | Promise<void>) | undefined,
    job: McodaGpuJobOpsPanelJob,
    message: string
  ) => {
    if (!action) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      await action(job);
      setStatusMessage(message);
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
          "Configure mswarm access and assign local, cloud, self-hosted, or Worker mcoda targets to each runtime stage."
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
    props.gpuJobOps
      ? React.createElement(components.GpuJobOpsPanel, {
          ops: props.gpuJobOps,
          busy,
          onRefresh: props.onGpuJobOpsRefresh ? refreshGpuJobOps : undefined,
          onViewDetails: props.onGpuJobViewDetails
            ? (job) => runGpuJobAction(props.onGpuJobViewDetails, job, `Loaded details for ${job.job_id}.`)
            : undefined,
          onViewLogs: props.onGpuJobViewLogs
            ? (job) => runGpuJobAction(props.onGpuJobViewLogs, job, `Loaded logs for ${job.job_id}.`)
            : undefined,
          onViewArtifacts: props.onGpuJobViewArtifacts
            ? (job) => runGpuJobAction(props.onGpuJobViewArtifacts, job, `Loaded artifacts for ${job.job_id}.`)
            : undefined,
          onRetry: props.onGpuJobRetry
            ? (job) => runGpuJobAction(props.onGpuJobRetry, job, `Retry queued for ${job.job_id}.`)
            : undefined,
          onCancel: props.onGpuJobCancel
            ? (job) => runGpuJobAction(props.onGpuJobCancel, job, `Cancel requested for ${job.job_id}.`)
            : undefined,
        })
      : null,
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

export interface GpuJobOpsPanelProps {
  ops: McodaGpuJobOpsPanelData;
  busy?: boolean;
  onRefresh?: () => void | Promise<void>;
  onViewDetails?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
  onViewLogs?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
  onViewArtifacts?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
  onRetry?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
  onCancel?: (job: McodaGpuJobOpsPanelJob) => void | Promise<void>;
}

export function GpuJobOpsPanel(props: GpuJobOpsPanelProps): React.ReactElement {
  const { ops } = props;
  const jobs = ops.queue.jobs;
  const auditEvents = ops.audit.events.slice(0, 6);
  const stateEntries = Object.entries(ops.queue.totals_by_state).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const software = opsSoftwareMetric(ops);
  const showControls = Boolean(
    props.onViewDetails || props.onViewLogs || props.onViewArtifacts || props.onRetry || props.onCancel
  );
  return React.createElement(
    "section",
    { className: "mcoda-agent-setup__gpu-ops" },
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__card-heading" },
      React.createElement("div", null,
        React.createElement("h2", null, "GPU Job Operations"),
        React.createElement("p", null, `Node ${ops.node.node_id} · ${formatTimestamp(ops.generated_at)}`)
      ),
      props.onRefresh
        ? React.createElement(
            "button",
            {
              type: "button",
              className: "mcoda-agent-setup__button mcoda-agent-setup__button--secondary",
              disabled: props.busy,
              onClick: props.onRefresh,
            },
            props.busy ? "Refreshing" : "Refresh"
          )
        : React.createElement(
            "span",
            {
              className: ops.node.generic_jobs_enabled
                ? "mcoda-agent-setup__badge mcoda-agent-setup__badge--success"
                : "mcoda-agent-setup__badge mcoda-agent-setup__badge--warning",
            },
            ops.node.generic_jobs_enabled ? "Enabled" : "Disabled"
          )
    ),
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__metric-grid" },
      React.createElement(MetricCard, {
        label: "Queue",
        value: String(ops.usage.total_jobs),
        detail: `${ops.queue.active_jobs} active, ${ops.queue.queued_jobs} queued`,
      }),
      React.createElement(MetricCard, {
        label: "Slots",
        value: `${ops.quota.available_slots}/${ops.quota.max_concurrent_jobs}`,
        detail: "available concurrency",
      }),
      React.createElement(MetricCard, {
        label: "GPU time",
        value: formatDurationSeconds(ops.usage.gpu_seconds),
        detail: "owner-local runtime",
      }),
      React.createElement(MetricCard, {
        label: "Artifacts",
        value: String(ops.usage.artifact_count),
        detail: formatBytes(ops.usage.artifact_bytes),
      }),
      React.createElement(MetricCard, {
        label: "Job types",
        value: opsJobTypes(ops),
        detail: opsGpuSummary(ops),
      }),
      React.createElement(MetricCard, {
        label: "Software",
        value: software.value,
        detail: software.detail,
      }),
      React.createElement(MetricCard, {
        label: "Audit",
        value: String(ops.audit.total),
        detail: `${ops.audit.limit} visible from ${ops.audit.offset}`,
      })
    ),
    stateEntries.length
      ? React.createElement(
          "div",
          { className: "mcoda-agent-setup__state-chips", "aria-label": "GPU job states" },
          stateEntries.map(([state, count]) =>
            React.createElement(
              "span",
              { key: state, className: `mcoda-agent-setup__state-chip mcoda-agent-setup__state-chip--${state}` },
              React.createElement("strong", null, String(count)),
              React.createElement("span", null, state)
            )
          )
        )
      : null,
    React.createElement(
      "div",
      { className: "mcoda-agent-setup__gpu-ops-grid" },
      React.createElement(
        "div",
        { className: "mcoda-agent-setup__gpu-ops-panel" },
        React.createElement("h3", null, "Jobs"),
        jobs.length
          ? React.createElement(
              "div",
              { className: "mcoda-agent-setup__gpu-table-wrap" },
              React.createElement(
                "table",
                { className: "mcoda-agent-setup__gpu-table" },
                React.createElement(
                  "thead",
                  null,
                  React.createElement(
                    "tr",
                    null,
                    React.createElement("th", null, "Job"),
                    React.createElement("th", null, "State"),
                    React.createElement("th", null, "Progress"),
                    React.createElement("th", null, "Artifacts"),
                    showControls ? React.createElement("th", null, "Actions") : null
                  )
                ),
                React.createElement(
                  "tbody",
                  null,
                  jobs.map((job) => {
                    const terminal = isTerminalGpuJobState(job.state);
                    const retryable = terminal && job.state !== "succeeded";
                    return React.createElement(
                      "tr",
                      { key: job.job_id },
                      React.createElement(
                        "td",
                        { className: "mcoda-agent-setup__gpu-job-cell" },
                        React.createElement("strong", null, job.job_id),
                        React.createElement("small", null, `${job.job_type} · ${formatTimestamp(job.updated_at)}`)
                      ),
                      React.createElement(
                        "td",
                        null,
                        React.createElement(
                          "span",
                          { className: `mcoda-agent-setup__badge ${terminal ? "mcoda-agent-setup__badge--info" : "mcoda-agent-setup__badge--success"}` },
                          job.state
                        )
                      ),
                      React.createElement("td", null, formatPercent(job.progress_percent)),
                      React.createElement("td", null, `${job.artifact_count} / ${formatBytes(job.artifact_bytes)}`),
                      showControls
                        ? React.createElement(
                            "td",
                            null,
                            React.createElement(
                              "div",
                              { className: "mcoda-agent-setup__gpu-actions" },
                              props.onViewDetails
                                ? React.createElement(
                                    "button",
                                    {
                                      type: "button",
                                      className: "mcoda-agent-setup__button mcoda-agent-setup__button--secondary",
                                      disabled: props.busy,
                                      onClick: () => props.onViewDetails?.(job),
                                    },
                                    "Details"
                                  )
                                : null,
                              props.onViewLogs
                                ? React.createElement(
                                    "button",
                                    {
                                      type: "button",
                                      className: "mcoda-agent-setup__button mcoda-agent-setup__button--secondary",
                                      disabled: props.busy,
                                      onClick: () => props.onViewLogs?.(job),
                                    },
                                    "Logs"
                                  )
                                : null,
                              props.onViewArtifacts
                                ? React.createElement(
                                    "button",
                                    {
                                      type: "button",
                                      className: "mcoda-agent-setup__button mcoda-agent-setup__button--secondary",
                                      disabled: props.busy,
                                      onClick: () => props.onViewArtifacts?.(job),
                                    },
                                    "Artifacts"
                                  )
                                : null,
                              props.onCancel
                                ? React.createElement(
                                    "button",
                                    {
                                      type: "button",
                                      className: "mcoda-agent-setup__button mcoda-agent-setup__button--secondary",
                                      disabled: props.busy || terminal,
                                      onClick: () => props.onCancel?.(job),
                                    },
                                    "Cancel"
                                  )
                                : null,
                              props.onRetry
                                ? React.createElement(
                                    "button",
                                    {
                                      type: "button",
                                      className: "mcoda-agent-setup__button mcoda-agent-setup__button--primary",
                                      disabled: props.busy || !retryable,
                                      onClick: () => props.onRetry?.(job),
                                    },
                                    "Retry"
                                  )
                                : null
                            )
                          )
                        : null
                    );
                  })
                )
              )
            )
          : React.createElement("p", { className: "mcoda-agent-setup__gpu-empty" }, "No GPU jobs recorded.")
      ),
      React.createElement(
        "div",
        { className: "mcoda-agent-setup__gpu-ops-panel" },
        React.createElement("h3", null, "Audit"),
        auditEvents.length
          ? React.createElement(
              "ol",
              { className: "mcoda-agent-setup__audit-list" },
              auditEvents.map((event, index) =>
                React.createElement(
                  "li",
                  { key: `${event.timestamp}-${event.action}-${index}` },
                  React.createElement("strong", null, event.action),
                  React.createElement("span", null, formatTimestamp(event.timestamp))
                )
              )
            )
          : React.createElement("p", { className: "mcoda-agent-setup__gpu-empty" }, "No audit events recorded.")
      )
    )
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
        label: "Local runners",
        value: String(localAssignableAgents(snapshot).length),
        detail: "unmanaged registry entries",
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
      }),
      React.createElement(MetricCard, {
        label: "Workers",
        value: String(snapshot.catalog.workerAgents.length),
        detail: "mswarm Worker catalog",
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
            : "Add a key to load real cloud, self-hosted, and Worker agents."
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
  const [sources, setSources] = React.useState<Record<string, AgentAssignmentSource>>({});
  const [servers, setServers] = React.useState<Record<string, string>>({});
  const localAgents = React.useMemo(
    () => localAssignableAgents(props.snapshot),
    [props.snapshot]
  );

  React.useEffect(() => {
    const nextSources: Record<string, AgentAssignmentSource> = {};
    const nextServers: Record<string, string> = {};
    for (const stage of props.stages) {
      const assignment = props.assignments[stage.stageKey];
      if (!assignment) continue;
      if (props.snapshot.catalog.workerAgents.some((agent) => agent.slug === assignment)) {
        nextSources[stage.stageKey] = "worker";
        continue;
      }
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
        continue;
      }
      if (localAgents.some((agent) => agent.slug === assignment)) {
        nextSources[stage.stageKey] = "local";
      }
    }
    setSources((current) => ({ ...current, ...nextSources }));
    setServers((current) => ({ ...current, ...nextServers }));
  }, [
    props.assignments,
    props.snapshot.catalog.cloudAgents,
    props.snapshot.catalog.selfHostedServers,
    props.snapshot.catalog.workerAgents,
    localAgents,
    props.stages,
  ]);

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
              defaultAssignmentSource(stage.preferredSource);
            const serverId = servers[stage.stageKey];
            const server =
              props.snapshot.catalog.selfHostedServers.find(
                (candidate) => candidate.id === serverId
              ) ?? props.snapshot.catalog.selfHostedServers[0];
            const agents =
              source === "local"
                ? localAgents
                : source === "cloud"
                ? props.snapshot.catalog.cloudAgents
                : source === "worker"
                  ? props.snapshot.catalog.workerAgents
                  : server?.agents ?? [];
            const allSelectableAgents = [
              ...localAgents,
              ...props.snapshot.catalog.cloudAgents,
              ...props.snapshot.catalog.selfHostedServers.flatMap(
                (candidate) => candidate.agents
              ),
              ...props.snapshot.catalog.workerAgents,
            ];
            const selectedAgent = allSelectableAgents.find(
              (agent) => agent.slug === selectedSlug
            );
            const agentSelectValue = agents.some(
              (agent) => agent.slug === selectedSlug
            )
              ? selectedSlug
              : "";
            const onSourceChange = (value: AgentAssignmentSource) => {
              setSources((current) => ({ ...current, [stage.stageKey]: value }));
              const nextSlug =
                value === "local"
                  ? localAgents[0]?.slug
                  : value === "cloud"
                  ? props.snapshot.catalog.cloudAgents[0]?.slug
                  : value === "worker"
                    ? props.snapshot.catalog.workerAgents[0]?.slug
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
                      source === "worker"
                        ? "Worker catalog"
                        : source === "local"
                          ? "Local registry"
                          : "Cloud catalog"
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
  value: AgentAssignmentSource;
  labels?: Partial<McodaAgentSetupLabels>;
  onChange: (value: AgentAssignmentSource) => void;
}): React.ReactElement {
  const labels = { ...DEFAULT_LABELS, ...(props.labels ?? {}) };
  return React.createElement(
    "div",
    { className: "mcoda-agent-setup__source", role: "group", "aria-label": "Agent source" },
    React.createElement(
      "button",
      {
        type: "button",
        "aria-pressed": props.value === "local",
        onClick: () => props.onChange("local"),
      },
      labels.local
    ),
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
    ),
    React.createElement(
      "button",
      {
        type: "button",
        "aria-pressed": props.value === "worker",
        onClick: () => props.onChange("worker"),
      },
      labels.workers
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

const GPU_TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "expired", "blocked"]);

function isTerminalGpuJobState(state: string): boolean {
  return GPU_TERMINAL_STATES.has(state);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function opsJobTypes(ops: McodaGpuJobOpsPanelData): string {
  const value = ops.capabilities.job_types;
  if (!Array.isArray(value) || value.length === 0) return "none";
  return value.map((entry) => String(entry)).slice(0, 3).join(", ");
}

function opsGpuSummary(ops: McodaGpuJobOpsPanelData): string {
  const accelerators = asRecord(ops.capabilities.accelerators);
  const gpu = asRecord(accelerators.gpu);
  const vendors = Array.isArray(gpu.vendors)
    ? gpu.vendors.map((entry) => String(entry)).join(", ")
    : "";
  const count = typeof gpu.count === "number" ? `${gpu.count} GPU${gpu.count === 1 ? "" : "s"}` : null;
  const cuda = gpu.cuda === true ? "CUDA" : gpu.cuda === false ? "no CUDA" : null;
  const vram = typeof gpu.vram_tier === "string" ? gpu.vram_tier : null;
  return [count, vendors, cuda, vram].filter(Boolean).join(" / ") || "capability snapshot";
}

function opsSoftwareMetric(ops: McodaGpuJobOpsPanelData): { value: string; detail: string } {
  const software = asRecord(ops.capabilities.software);
  const entries = Object.entries(software)
    .map(([name, value]) => [name, asRecord(value)] as const)
    .filter(([, value]) => Object.keys(value).length > 0);
  if (entries.length === 0) {
    return { value: "unknown", detail: "software probes unavailable" };
  }
  const available = entries.filter(([, value]) => value.available === true || value.status === "available").length;
  return {
    value: `${available}/${entries.length} available`,
    detail: entries
      .map(([name, value]) => `${name}: ${typeof value.status === "string" ? value.status : value.available === true ? "available" : "unknown"}`)
      .join(", "),
  };
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function formatDurationSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0s";
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next >= 10 || unit === 0 ? Math.round(next) : next.toFixed(1)} ${units[unit]}`;
}

function AgentStatusBadge(props: {
  agent: McodaAgentCatalogEntry | undefined;
  slug: string;
}): React.ReactElement {
  const kind = props.agent?.managedKind;
  const sourceLabel =
    kind === "cloud"
      ? "Cloud"
      : kind === "self_hosted_load_balanced"
        ? "Auto self-hosted"
      : kind === "self_hosted"
        ? "Self-hosted"
        : kind === "worker"
          ? "Worker"
        : props.agent
          ? props.agent.localRunner
            ? "Local runner"
            : "Local"
          : props.slug
            ? "Missing"
            : "Unset";
  const className =
    kind === "cloud"
      ? "mcoda-agent-setup__badge mcoda-agent-setup__badge--info"
      : kind === "self_hosted_load_balanced"
        ? "mcoda-agent-setup__badge mcoda-agent-setup__badge--success"
      : kind === "self_hosted"
        ? "mcoda-agent-setup__badge mcoda-agent-setup__badge--success"
        : kind === "worker"
          ? "mcoda-agent-setup__badge mcoda-agent-setup__badge--worker"
        : props.agent
          ? "mcoda-agent-setup__badge"
          : "mcoda-agent-setup__badge mcoda-agent-setup__badge--warning";
  return React.createElement("span", { className }, sourceLabel);
}

function defaultAssignmentSource(
  preferredSource: McodaStageDefinition["preferredSource"]
): AgentAssignmentSource {
  if (preferredSource === "self_hosted") return "self_hosted";
  if (preferredSource === "worker") return "worker";
  return "cloud";
}

function firstSelfHostedAgentSlug(servers: McodaSelfHostedServer[]): string | null {
  return servers.find((server) => server.agents.length > 0)?.agents[0]?.slug ?? null;
}

function localAssignableAgents(snapshot: McodaAgentSetupSnapshot): McodaAgentCatalogEntry[] {
  return snapshot.catalog.localAgents.filter((agent) => !agent.managedKind);
}

function agentTitle(agent: McodaAgentCatalogEntry): string {
  return agent.displayName ?? prettySlug(agent.slug);
}

function agentMetadata(agent: McodaAgentCatalogEntry): string {
  const runnerDetail = agent.localRunner
    ? [
        agent.localRunner.runnerKind,
        agent.localRunner.baseUrl,
        agent.localRunner.responseFormatStrategy,
      ]
        .filter(Boolean)
        .join(" / ")
    : null;
  return (
    [
      agent.defaultModel ?? agent.model,
      agent.provider,
      runnerDetail,
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
    .replace(/^mswarm-worker-/, "")
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
