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
</main>

<script>
(() => {
    const apiBase = @json($apiBasePath);
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
    const state = { snapshot: null, filter: '' };

    const status = document.getElementById('status');
    const errors = document.getElementById('errors');
    const stages = document.getElementById('stages');
    const filter = document.getElementById('agent-filter');
    const keyInput = document.getElementById('mswarm-api-key');

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
            return [agent.slug, agent.displayName, agent.provider, agent.model, agent.serverLabel, agent.serverName]
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
                const text = [agent.displayName || agent.slug, agent.model, agent.provider]
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
