import { QaPlan, QaTaskPlan } from '@mcoda/shared';
import type { QaBrowserAction } from '@mcoda/shared/qa/QaPlan.js';

type NormalizedQaPlan = {
  taskProfiles: Record<string, string[]>;
  taskPlans: Record<string, QaTaskPlan>;
  notes?: string;
  warnings: string[];
};

const toStringList = (value: unknown): string[] => {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const ASSERT_TEXT_OK_MARKER = '__MCODA_ASSERT_OK__';

const buildAssertTextExpression = (params: {
  selector?: string;
  text: string;
  contains: boolean;
}): string => {
  const textExpression = params.selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`
    : `document.body ? (document.body.innerText || document.body.textContent || '') : ''`;
  const expected = JSON.stringify(params.text);
  const comparison = params.contains ? 'actual.includes(expected)' : 'actual.trim() === expected';
  return `(() => { const actual = ${textExpression}; const expected = ${expected}; const ok = ${comparison}; return ok ? ${JSON.stringify(ASSERT_TEXT_OK_MARKER)} : actual; })()`;
};

const normalizeBrowserActions = (
  entries: unknown[],
  warnings: string[],
  taskKey?: string,
): QaBrowserAction[] => {
  const actions: QaBrowserAction[] = [];
  const context = taskKey ? ` for ${taskKey}` : '';
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const action = entry as Record<string, unknown>;
    const rawType = typeof action.type === 'string' ? action.type : '';
    if (rawType === 'assertText' || rawType === 'assert_text') {
      const text = typeof action.text === 'string' ? action.text.trim() : '';
      if (!text) {
        warnings.push(`QA plan browser action ${rawType} missing text${context}.`);
        continue;
      }
      const selector = typeof action.selector === 'string' ? action.selector : undefined;
      const contains = typeof action.contains === 'boolean' ? action.contains : true;
      actions.push({
        type: 'script',
        expression: buildAssertTextExpression({ selector, text, contains }),
        expect: ASSERT_TEXT_OK_MARKER,
      });
      continue;
    }
    actions.push(action as QaBrowserAction);
  }
  return actions;
};

const normalizePlanEntry = (
  value: unknown,
  warnings: string[],
  taskKey?: string,
): QaTaskPlan | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const profiles = toStringList(raw.profiles);
  const cliCommands = toStringList((raw.cli as any)?.commands);
  const apiRequests = Array.isArray((raw.api as any)?.requests)
    ? ((raw.api as any).requests as unknown[]).filter((entry) => typeof entry === 'object' && entry)
    : [];
  const rawBrowserActions = Array.isArray((raw.browser as any)?.actions)
    ? ((raw.browser as any).actions as unknown[]).filter((entry) => typeof entry === 'object' && entry)
    : [];
  const browserActions = normalizeBrowserActions(rawBrowserActions, warnings, taskKey);
  const stressApi = Array.isArray((raw.stress as any)?.api)
    ? ((raw.stress as any).api as unknown[]).filter((entry) => typeof entry === 'object' && entry)
    : [];
  const stressBrowser = Array.isArray((raw.stress as any)?.browser)
    ? ((raw.stress as any).browser as unknown[]).filter((entry) => typeof entry === 'object' && entry)
    : [];
  const plan: QaTaskPlan = {};
  if (profiles.length) plan.profiles = profiles;
  if (cliCommands.length) plan.cli = { commands: cliCommands };
  if (apiRequests.length || typeof (raw.api as any)?.base_url === 'string') {
    plan.api = {
      base_url: typeof (raw.api as any)?.base_url === 'string' ? ((raw.api as any).base_url as string) : undefined,
      requests: apiRequests as any,
    };
  }
  if (browserActions.length || typeof (raw.browser as any)?.base_url === 'string') {
    plan.browser = {
      base_url:
        typeof (raw.browser as any)?.base_url === 'string' ? ((raw.browser as any).base_url as string) : undefined,
      actions: browserActions.length ? browserActions : undefined,
    };
  }
  if (stressApi.length || stressBrowser.length) {
    plan.stress = {
      api: stressApi as any,
      browser: stressBrowser as any,
    };
  }
  return Object.keys(plan).length ? plan : undefined;
};

export const normalizeQaPlanOutput = (value: unknown): NormalizedQaPlan => {
  const warnings: string[] = [];
  if (!value || typeof value !== 'object') {
    warnings.push('QA plan output is not an object.');
    return { taskProfiles: {}, taskPlans: {}, warnings };
  }
  const raw = value as QaPlan & Record<string, unknown>;
  const taskProfilesRaw = (raw as any).task_profiles ?? (raw as any).taskProfiles;
  const taskPlansRaw = (raw as any).task_plans ?? (raw as any).taskPlans ?? (raw as any).tasks;

  const taskProfiles: Record<string, string[]> = {};
  if (taskProfilesRaw && typeof taskProfilesRaw === 'object') {
    for (const [key, entry] of Object.entries(taskProfilesRaw as Record<string, unknown>)) {
      const list = toStringList(entry);
      if (list.length) taskProfiles[key] = list;
    }
  } else if (taskProfilesRaw !== undefined) {
    warnings.push('QA plan task_profiles is not an object.');
  }

  const taskPlans: Record<string, QaTaskPlan> = {};
  if (taskPlansRaw && typeof taskPlansRaw === 'object') {
    for (const [key, entry] of Object.entries(taskPlansRaw as Record<string, unknown>)) {
      const normalized = normalizePlanEntry(entry, warnings, key);
      if (normalized) taskPlans[key] = normalized;
    }
  } else if (taskPlansRaw !== undefined) {
    warnings.push('QA plan task_plans is not an object.');
  }

  return {
    taskProfiles,
    taskPlans,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
    warnings,
  };
};
