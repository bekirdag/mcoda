<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>{{ $pageTitle ?? 'mcoda Agent Setup' }}</title>
    <style>
        :root {
            color-scheme: light;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.5;
        }
        body {
            margin: 0;
            background: #f7f8fb;
            color: #111827;
        }
        main {
            width: min(1100px, calc(100% - 32px));
            margin: 24px auto 48px;
        }
        h1 {
            margin: 0 0 18px;
            font-size: 28px;
            font-weight: 700;
        }
        section {
            margin-top: 16px;
            padding: 18px;
            border: 1px solid #d9dee8;
            border-radius: 8px;
            background: #ffffff;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
            font-weight: 600;
            color: #374151;
        }
        input, select {
            width: 100%;
            box-sizing: border-box;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            padding: 9px 10px;
            font: inherit;
            background: #ffffff;
        }
        button {
            border: 0;
            border-radius: 6px;
            padding: 9px 12px;
            font: inherit;
            font-weight: 600;
            color: #ffffff;
            background: #174ea6;
            cursor: pointer;
        }
        button.secondary {
            color: #174ea6;
            background: #e8f0fe;
        }
        button:disabled {
            opacity: 0.55;
            cursor: not-allowed;
        }
        .toolbar {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            align-items: end;
        }
        .toolbar > div {
            flex: 1 1 260px;
        }
        .status {
            margin-top: 10px;
            font-size: 13px;
            color: #4b5563;
        }
        .errors {
            margin: 12px 0 0;
            padding: 10px 12px;
            border-radius: 6px;
            background: #fff7ed;
            color: #9a3412;
            font-size: 13px;
        }
        .section-heading {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: center;
        }
        .section-heading h2 {
            margin: 0;
            font-size: 18px;
        }
        .ops-metrics {
            display: grid;
            gap: 12px;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            margin-top: 14px;
        }
        .metric {
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 12px;
            background: #f8fafc;
        }
        .metric span {
            display: block;
            font-size: 12px;
            color: #64748b;
        }
        .metric strong {
            display: block;
            margin-top: 6px;
            font-size: 20px;
        }
        .ops-grid {
            display: grid;
            grid-template-columns: minmax(0, 1.5fr) minmax(260px, 0.8fr);
            gap: 14px;
            margin-top: 14px;
        }
        .ops-panel {
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            overflow: hidden;
        }
        .ops-panel h3 {
            margin: 0;
            padding: 10px 12px;
            font-size: 14px;
            background: #f8fafc;
            border-bottom: 1px solid #e5e7eb;
        }
        .ops-table {
            width: 100%;
            border-collapse: collapse;
            min-width: 640px;
        }
        .ops-table th,
        .ops-table td {
            padding: 10px 12px;
            border-top: 1px solid #eef2f7;
            text-align: left;
            font-size: 13px;
        }
        .ops-table th {
            color: #64748b;
            font-size: 12px;
        }
        .ops-table-wrap {
            overflow-x: auto;
        }
        .ops-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .ops-actions button {
            padding: 6px 9px;
            font-size: 13px;
        }
        .ops-empty {
            margin: 0;
            padding: 12px;
            color: #64748b;
            font-size: 13px;
        }
        .audit-list {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        .audit-list li {
            display: grid;
            gap: 3px;
            border-top: 1px solid #eef2f7;
            padding: 10px 12px;
            font-size: 13px;
        }
        .audit-list li:first-child {
            border-top: 0;
        }
        .audit-list span {
            color: #64748b;
            font-size: 12px;
        }
        .ops-panel--details {
            grid-column: 1 / -1;
        }
        .ops-detail {
            padding: 12px;
        }
        .ops-detail h4 {
            margin: 0 0 8px;
            font-size: 14px;
        }
        .ops-detail-list {
            list-style: none;
            margin: 0;
            padding: 0;
        }
        .ops-detail-list li {
            display: grid;
            gap: 3px;
            padding: 9px 0;
            border-top: 1px solid #eef2f7;
            font-size: 13px;
        }
        .ops-detail-list li:first-child {
            border-top: 0;
        }
        .ops-detail-list span {
            color: #64748b;
            font-size: 12px;
        }
        .ops-detail pre {
            margin: 10px 0 0;
            max-height: 320px;
            overflow: auto;
            border-radius: 6px;
            padding: 10px;
            background: #0f172a;
            color: #e2e8f0;
            font-size: 12px;
        }
        .stage-grid {
            display: grid;
            gap: 12px;
        }
        .stage-row {
            display: grid;
            grid-template-columns: minmax(180px, 260px) 1fr;
            gap: 12px;
            align-items: start;
            padding: 12px 0;
            border-top: 1px solid #eef2f7;
        }
        .stage-row:first-child {
            border-top: 0;
        }
        .stage-name {
            font-weight: 700;
        }
        .stage-description {
            margin-top: 4px;
            font-size: 13px;
            color: #64748b;
        }
        @media (max-width: 720px) {
            .stage-row {
                grid-template-columns: 1fr;
            }
            .ops-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
<main>
    <h1>{{ $pageTitle ?? 'mcoda Agent Setup' }}</h1>

    <section>
        <div class="toolbar">
            <div>
                <label for="mswarm-api-key">mswarm API key</label>
                <input id="mswarm-api-key" type="password" autocomplete="off" placeholder="Paste a new key">
            </div>
            <button id="save-key" type="button">Save key</button>
            <button id="sync-agents" type="button" class="secondary">Sync agents</button>
        </div>
        <div id="status" class="status">Loading setup state...</div>
        <div id="errors" class="errors" hidden></div>
    </section>

    <section>
        <div class="toolbar">
            <div>
                <label for="agent-filter">Filter agents</label>
                <input id="agent-filter" type="search" placeholder="Search by slug, model, provider, or server">
            </div>
            <button id="save-assignments" type="button">Save assignments</button>
        </div>
        <div id="stages" class="stage-grid" aria-live="polite"></div>
    </section>

    <section>
        <div class="section-heading">
            <div>
                <h2>Owner-local GPU Jobs</h2>
                <div id="gpu-status" class="status">Loading GPU job operations...</div>
            </div>
            <button id="refresh-gpu-jobs" type="button" class="secondary">Refresh</button>
        </div>
        <div id="gpu-metrics" class="ops-metrics"></div>
        <div class="ops-grid">
            <div class="ops-panel">
                <h3>Jobs</h3>
                <div id="gpu-jobs" class="ops-table-wrap" aria-live="polite"></div>
            </div>
            <div class="ops-panel">
                <h3>Audit</h3>
                <div id="gpu-audit" aria-live="polite"></div>
            </div>
            <div class="ops-panel ops-panel--details">
                <h3>Job Details</h3>
                <div id="gpu-details" aria-live="polite">
                    <p class="ops-empty">Select a job row action to load details, logs, events, or artifacts.</p>
                </div>
            </div>
        </div>
    </section>
</main>

<script>
(() => {
    const apiBase = @json($apiBasePath);
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    const state = { snapshot: null, filter: '', gpuOps: null };

    const status = document.getElementById('status');
    const errors = document.getElementById('errors');
    const stages = document.getElementById('stages');
    const filter = document.getElementById('agent-filter');
    const keyInput = document.getElementById('mswarm-api-key');
    const gpuStatus = document.getElementById('gpu-status');
    const gpuMetrics = document.getElementById('gpu-metrics');
    const gpuJobs = document.getElementById('gpu-jobs');
    const gpuAudit = document.getElementById('gpu-audit');
    const gpuDetails = document.getElementById('gpu-details');

    async function request(path, options = {}) {
        const headers = {
            accept: 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            'x-csrf-token': csrf,
            ...(options.headers ?? {}),
        };
        let body;
        if (options.body !== undefined) {
            headers['content-type'] = 'application/json';
            body = JSON.stringify(options.body);
        }
        const response = await fetch(`${apiBase}${path}`, {
            method: options.method ?? 'GET',
            headers,
            body,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || `${response.status} ${response.statusText}`);
        }
        return payload;
    }

    function allAgents(snapshot) {
        const catalog = snapshot?.catalog ?? {};
        return [
            ...(catalog.cloudAgents ?? []),
            ...(catalog.selfHostedAgents ?? []),
            ...(catalog.workerAgents ?? []),
            ...(catalog.localAgents ?? []),
        ];
    }

    function agentLifecycleText(agent) {
        const lifecycle = agent.selfHostedLifecycle ?? {};
        return [
            agent.healthStatus && agent.healthStatus !== '-' ? agent.healthStatus : null,
            agent.healthReason ?? lifecycle.reason,
            lifecycle.missingRoute,
        ]
            .filter(Boolean)
            .join(': ');
    }

    function renderErrors(snapshot) {
        const catalogErrors = snapshot?.catalog?.errors ?? {};
        const entries = Object.entries(catalogErrors).filter(([, value]) => value);
        if (entries.length === 0) {
            errors.hidden = true;
            errors.textContent = '';
            return;
        }
        errors.hidden = false;
        errors.textContent = entries.map(([key, value]) => `${key}: ${value}`).join(' | ');
    }

    function formatTimestamp(value) {
        if (!value) return 'never';
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) return String(value);
        const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60000));
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.round(hours / 24)}d ago`;
    }

    function formatBytes(value) {
        let next = Number(value || 0);
        if (!Number.isFinite(next) || next <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let unit = 0;
        while (next >= 1024 && unit < units.length - 1) {
            next /= 1024;
            unit += 1;
        }
        return `${next >= 10 || unit === 0 ? Math.round(next) : next.toFixed(1)} ${units[unit]}`;
    }

    function appendMetric(container, label, value, detail) {
        const metric = document.createElement('div');
        metric.className = 'metric';
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        const valueEl = document.createElement('strong');
        valueEl.textContent = value;
        const detailEl = document.createElement('span');
        detailEl.textContent = detail;
        metric.append(labelEl, valueEl, detailEl);
        container.append(metric);
    }

    function gpuSoftwareMetric(ops) {
        const software = ops?.capabilities?.software;
        if (!software || typeof software !== 'object') {
            return { value: 'unknown', detail: 'software probes unavailable' };
        }
        const entries = Object.entries(software).filter(([, result]) => result && typeof result === 'object');
        if (entries.length === 0) {
            return { value: 'unknown', detail: 'software probes unavailable' };
        }
        const available = entries.filter(([, result]) => result.available === true || result.status === 'available').length;
        return {
            value: `${available}/${entries.length} available`,
            detail: entries.map(([name, result]) => `${name}: ${result.status ?? (result.available ? 'available' : 'unknown')}`).join(', '),
        };
    }

    function gpuJobTypes(ops) {
        const jobTypes = ops?.capabilities?.job_types;
        return Array.isArray(jobTypes) && jobTypes.length > 0 ? jobTypes.join(', ') : 'none';
    }

    function gpuSummary(ops) {
        const gpu = ops?.capabilities?.accelerators?.gpu;
        if (!gpu || typeof gpu !== 'object') {
            return 'GPU inventory unavailable';
        }
        const vendors = Array.isArray(gpu.vendors) && gpu.vendors.length > 0 ? gpu.vendors.join(', ') : 'unknown vendor';
        const cuda = gpu.cuda ? ', CUDA' : '';
        return `${gpu.count ?? 0} ${vendors}${cuda}`;
    }

    function jobReferencePayload(job) {
        return {
            requestId: job.request_id,
            schemaVersion: job.schema_version || state.gpuOps?.schema_version,
            jobType: job.job_type,
            nodeId: job.node_id || state.gpuOps?.node?.node_id,
        };
    }

    function jobReferenceQuery(job) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(jobReferencePayload(job))) {
            if (typeof value === 'string' && value.trim() !== '') {
                params.set(key, value);
            }
        }
        return params.toString();
    }

    function appendDetailList(container, entries, format) {
        const list = document.createElement('ol');
        list.className = 'ops-detail-list';
        for (const entry of entries) {
            const item = document.createElement('li');
            const formatted = format(entry);
            const title = document.createElement('strong');
            title.textContent = formatted.title;
            const detail = document.createElement('span');
            detail.textContent = formatted.detail;
            item.append(title, detail);
            list.append(item);
        }
        container.append(list);
    }

    function renderGpuJobDetail(job, view, payload) {
        gpuDetails.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'ops-detail';
        const heading = document.createElement('h4');
        heading.textContent = `${job.job_id} ${view}`;
        wrap.append(heading);

        if (view === 'logs' && Array.isArray(payload.logs) && payload.logs.length > 0) {
            appendDetailList(wrap, payload.logs, (entry) => ({
                title: `${entry.stream ?? 'log'} ${formatTimestamp(entry.timestamp)}`,
                detail: entry.message ?? JSON.stringify(entry),
            }));
        } else if (view === 'events' && Array.isArray(payload.events) && payload.events.length > 0) {
            appendDetailList(wrap, payload.events, (entry) => ({
                title: `${entry.type ?? 'event'} ${formatTimestamp(entry.timestamp)}`,
                detail: entry.message ?? JSON.stringify(entry),
            }));
        } else if (view === 'artifacts' && Array.isArray(payload.artifacts) && payload.artifacts.length > 0) {
            appendDetailList(wrap, payload.artifacts, (entry) => ({
                title: entry.name ?? entry.path ?? entry.uri ?? 'artifact',
                detail: `${entry.content_type ?? 'artifact'} · ${formatBytes(entry.size_bytes ?? 0)}`,
            }));
        } else {
            const empty = document.createElement('p');
            empty.className = 'ops-empty';
            empty.textContent = view === 'details' ? 'Lifecycle snapshot loaded.' : `No ${view} recorded.`;
            wrap.append(empty);
        }

        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(payload, null, 2);
        wrap.append(pre);
        gpuDetails.append(wrap);
    }

    function makeActionButton(label, className, disabled, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener('click', onClick);
        return button;
    }

    function renderGpuOps() {
        const ops = state.gpuOps;
        gpuMetrics.innerHTML = '';
        gpuJobs.innerHTML = '';
        gpuAudit.innerHTML = '';
        if (!ops) {
            gpuStatus.textContent = 'GPU job operations unavailable.';
            gpuJobs.textContent = '';
            gpuAudit.textContent = '';
            gpuDetails.innerHTML = '<p class="ops-empty">Select a job row action to load details, logs, events, or artifacts.</p>';
            return;
        }

        gpuStatus.textContent = `Node ${ops.node?.node_id ?? 'unknown'} updated ${formatTimestamp(ops.generated_at)}.`;
        appendMetric(gpuMetrics, 'Queue', String(ops.usage?.total_jobs ?? 0), `${ops.queue?.active_jobs ?? 0} active, ${ops.queue?.queued_jobs ?? 0} queued`);
        appendMetric(gpuMetrics, 'Slots', `${ops.quota?.available_slots ?? 0}/${ops.quota?.max_concurrent_jobs ?? 0}`, 'available concurrency');
        appendMetric(gpuMetrics, 'GPU seconds', String(ops.usage?.gpu_seconds ?? 0), 'owner-local runtime');
        appendMetric(gpuMetrics, 'Artifacts', String(ops.usage?.artifact_count ?? 0), formatBytes(ops.usage?.artifact_bytes ?? 0));
        appendMetric(gpuMetrics, 'Job types', gpuJobTypes(ops), gpuSummary(ops));
        const software = gpuSoftwareMetric(ops);
        appendMetric(gpuMetrics, 'Software', software.value, software.detail);

        const jobs = ops.queue?.jobs ?? [];
        if (jobs.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'ops-empty';
            empty.textContent = 'No GPU jobs recorded.';
            gpuJobs.append(empty);
        } else {
            const table = document.createElement('table');
            table.className = 'ops-table';
            const thead = document.createElement('thead');
            const headRow = document.createElement('tr');
            ['Job', 'State', 'Progress', 'Artifacts', 'Actions'].forEach((label) => {
                const th = document.createElement('th');
                th.textContent = label;
                headRow.append(th);
            });
            thead.append(headRow);
            table.append(thead);
            const tbody = document.createElement('tbody');
            for (const job of jobs) {
                const row = document.createElement('tr');
                const terminal = ['succeeded', 'failed', 'cancelled', 'expired', 'blocked'].includes(job.state);
                const retryable = terminal && job.state !== 'succeeded';
                const values = [
                    `${job.job_id} (${job.job_type}, priority ${job.priority ?? 0})`,
                    job.state,
                    typeof job.progress_percent === 'number' ? `${Math.round(job.progress_percent)}%` : '-',
                    `${job.artifact_count ?? 0} / ${formatBytes(job.artifact_bytes ?? 0)}`,
                ];
                for (const value of values) {
                    const td = document.createElement('td');
                    td.textContent = value;
                    row.append(td);
                }
                const actions = document.createElement('td');
                const actionWrap = document.createElement('div');
                actionWrap.className = 'ops-actions';
                const details = makeActionButton('Details', 'secondary', false, () => {
                    loadJobDetail(job, 'details').catch((error) => {
                        gpuStatus.textContent = error.message;
                    });
                });
                const logs = makeActionButton('Logs', 'secondary', false, () => {
                    loadJobDetail(job, 'logs').catch((error) => {
                        gpuStatus.textContent = error.message;
                    });
                });
                const events = makeActionButton('Events', 'secondary', false, () => {
                    loadJobDetail(job, 'events').catch((error) => {
                        gpuStatus.textContent = error.message;
                    });
                });
                const artifacts = makeActionButton('Artifacts', 'secondary', false, () => {
                    loadJobDetail(job, 'artifacts').catch((error) => {
                        gpuStatus.textContent = error.message;
                    });
                });
                const cancel = makeActionButton('Cancel', 'secondary', terminal, () => {
                    jobAction(job, 'cancel').catch((error) => {
                        gpuStatus.textContent = error.message;
                    });
                });
                const retry = makeActionButton('Retry', '', !retryable, () => {
                    jobAction(job, 'retry').catch((error) => {
                        gpuStatus.textContent = error.message;
                    });
                });
                actionWrap.append(details, logs, events, artifacts, cancel, retry);
                actions.append(actionWrap);
                row.append(actions);
                tbody.append(row);
            }
            table.append(tbody);
            gpuJobs.append(table);
        }

        const audit = ops.audit?.events ?? [];
        if (audit.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'ops-empty';
            empty.textContent = 'No audit events recorded.';
            gpuAudit.append(empty);
            return;
        }
        const list = document.createElement('ol');
        list.className = 'audit-list';
        for (const event of audit.slice(0, 8)) {
            const item = document.createElement('li');
            const action = document.createElement('strong');
            action.textContent = event.action;
            const time = document.createElement('span');
            time.textContent = `${event.job_id ?? 'job'} · ${formatTimestamp(event.timestamp)}`;
            item.append(action, time);
            list.append(item);
        }
        gpuAudit.append(list);
    }

    function render() {
        const snapshot = state.snapshot;
        if (!snapshot) return;

        const keyText = snapshot.mswarmApiKeyConfigured
            ? `API key configured${snapshot.mswarmApiKeyLast4 ? `, ending in ${snapshot.mswarmApiKeyLast4}` : ''}.`
            : 'No mswarm API key configured.';
        status.textContent = `${keyText} Runtime: ${snapshot.runtime?.mode ?? 'unknown'}.`;
        renderErrors(snapshot);

        const agents = allAgents(snapshot).filter((agent) => {
            const term = state.filter.trim().toLowerCase();
            if (!term) return true;
            return [
                agent.slug,
                agent.displayName,
                agent.provider,
                agent.model,
                agent.serverLabel,
                agent.serverName,
                agentLifecycleText(agent),
                agent.selfHostedLifecycle?.runtimePackageVersion,
                agent.selfHostedLifecycle?.relay?.gatewayBaseUrl,
                agent.selfHostedLifecycle?.relay?.jobsStartPathTemplate,
                agent.selfHostedLifecycle?.relay?.jobsEventsPathTemplate,
                agent.selfHostedLifecycle?.relay?.jobsResultPathTemplate,
            ]
                .filter(Boolean)
                .some((value) => String(value).toLowerCase().includes(term));
        });

        stages.innerHTML = '';
        for (const stage of snapshot.stages ?? []) {
            const row = document.createElement('div');
            row.className = 'stage-row';

            const label = document.createElement('div');
            label.innerHTML = `<div class="stage-name"></div><div class="stage-description"></div>`;
            label.querySelector('.stage-name').textContent = stage.displayName ?? stage.stageKey;
            label.querySelector('.stage-description').textContent = stage.description ?? '';

            const select = document.createElement('select');
            select.dataset.stageKey = stage.stageKey;
            select.append(new Option('Unassigned', ''));
            for (const agent of agents) {
                const text = [
                    agent.displayName || agent.slug,
                    agent.model,
                    agent.provider,
                    agentLifecycleText(agent),
                ]
                    .filter(Boolean)
                    .join(' - ');
                select.append(new Option(text, agent.slug));
            }
            select.value = snapshot.assignments?.[stage.stageKey] ?? '';

            row.append(label, select);
            stages.append(row);
        }
    }

    async function load() {
        state.snapshot = await request('/agent-settings');
        render();
        loadGpuOps().catch((error) => {
            gpuStatus.textContent = error.message;
        });
    }

    async function loadGpuOps() {
        gpuStatus.textContent = 'Loading GPU job operations...';
        state.gpuOps = await request('/gpu-jobs/ops?audit_limit=25&audit_offset=0');
        renderGpuOps();
    }

    async function loadJobDetail(job, view) {
        const suffixes = {
            details: '',
            logs: '/logs',
            events: '/events',
            artifacts: '/artifacts',
        };
        const suffix = suffixes[view] ?? '';
        const query = jobReferenceQuery(job);
        gpuStatus.textContent = `Loading ${view} for ${job.job_id}...`;
        const payload = await request(`/gpu-jobs/${encodeURIComponent(job.job_id)}${suffix}${query ? `?${query}` : ''}`);
        renderGpuJobDetail(job, view, payload);
        gpuStatus.textContent = `Loaded ${view} for ${job.job_id}.`;
    }

    async function jobAction(job, action) {
        gpuStatus.textContent = `${action === 'retry' ? 'Retrying' : 'Cancelling'} ${job.job_id}...`;
        await request(`/gpu-jobs/${encodeURIComponent(job.job_id)}/${action}`, {
            method: 'POST',
            body: jobReferencePayload(job),
        });
        await loadGpuOps();
    }

    document.getElementById('save-key').addEventListener('click', async () => {
        const value = keyInput.value.trim();
        if (!value) {
            status.textContent = 'Paste an mswarm API key before saving.';
            return;
        }
        state.snapshot = await request('/mswarm-api-key', {
            method: 'POST',
            body: { mswarm_api_key: value, reason_code: 'laravel_admin_setup' },
        });
        keyInput.value = '';
        render();
    });

    document.getElementById('sync-agents').addEventListener('click', async () => {
        state.snapshot = await request('/agents/sync', {
            method: 'POST',
            body: { reason_code: 'laravel_admin_sync' },
        });
        render();
    });

    document.getElementById('save-assignments').addEventListener('click', async () => {
        const assignments = {};
        for (const select of stages.querySelectorAll('select[data-stage-key]')) {
            assignments[select.dataset.stageKey] = select.value || null;
        }
        state.snapshot = await request('/agent-settings', {
            method: 'PATCH',
            body: { assignments, reason_code: 'laravel_admin_assignment_update' },
        });
        render();
    });

    document.getElementById('refresh-gpu-jobs').addEventListener('click', async () => {
        await loadGpuOps().catch((error) => {
            gpuStatus.textContent = error.message;
        });
    });

    filter.addEventListener('input', () => {
        state.filter = filter.value;
        render();
    });

    load().catch((error) => {
        status.textContent = error.message;
    });
})();
</script>
</body>
</html>
