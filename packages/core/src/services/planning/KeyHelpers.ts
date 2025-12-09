const AREA_ALIASES: Record<string, string> = {
  admin: "adm",
  backend: "bck",
  infra: "ops",
  infrastructure: "ops",
  operations: "ops",
  ops: "ops",
  platform: "ops",
  frontend: "web",
  front: "web",
  web: "web",
  ui: "web",
  mobile: "mob",
};

const escapeRegex = (value: string): string => value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

const pad = (num: number, width = 2): string => String(num).padStart(width, "0");

const nextIndexedKey = (
  existing: Set<string>,
  formatter: (index: number) => string,
  matcher: (value: string) => number | undefined,
): string => {
  let max = 0;
  for (const key of existing) {
    const idx = matcher(key);
    if (idx && idx > max) {
      max = idx;
    }
  }
  const next = max + 1;
  const result = formatter(next);
  existing.add(result);
  return result;
};

export const normalizeAreaCode = (input: string | undefined, fallback: string): string => {
  if (!input) return fallback;
  const normalized = input.trim().toLowerCase();
  return (AREA_ALIASES[normalized] ?? normalized) || fallback;
};

export const createEpicKeyGenerator = (projectKey: string, existingKeys: Iterable<string> = []): ((area?: string) => string) => {
  const known = new Set(existingKeys);
  return (area?: string) => {
    const code = normalizeAreaCode(area, projectKey);
    const pattern = new RegExp(`^${escapeRegex(code)}-(\\d+)$`);
    return nextIndexedKey(known, (idx) => `${code}-${pad(idx)}`, (value) => {
      const match = value.match(pattern);
      return match ? Number(match[1]) : undefined;
    });
  };
};

export const createStoryKeyGenerator = (
  epicKey: string,
  existingKeys: Iterable<string> = [],
): (() => string) => {
  const known = new Set(existingKeys);
  const pattern = new RegExp(`^${escapeRegex(epicKey)}-us-(\\d+)$`);
  return () =>
    nextIndexedKey(known, (idx) => `${epicKey}-us-${pad(idx)}`, (value) => {
      const match = value.match(pattern);
      return match ? Number(match[1]) : undefined;
    });
};

export const createTaskKeyGenerator = (
  storyKey: string,
  existingKeys: Iterable<string> = [],
): (() => string) => {
  const known = new Set(existingKeys);
  const pattern = new RegExp(`^${escapeRegex(storyKey)}-t(\\d+)$`);
  return () =>
    nextIndexedKey(known, (idx) => `${storyKey}-t${pad(idx)}`, (value) => {
      const match = value.match(pattern);
      return match ? Number(match[1]) : undefined;
    });
};
