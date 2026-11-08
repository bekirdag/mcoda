import path from "node:path";

/** POSIX workspace-relative scopes. Normalize harmless directory notation only;
 * never normalize away traversal or interpret an empty scope as the root. */
const canonical = (value: string): string | undefined => {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) return;
  return path.posix.normalize(value).replace(/\/$/, "");
};

export const isWithinScope = (file: string, scopes: readonly string[]): boolean => {
  const target = canonical(file);
  if (target === undefined) return false;
  return scopes.some(value => {
    const scope = canonical(value);
    return scope !== undefined && (scope === "." || target === scope || target.startsWith(`${scope}/`));
  });
};

export const scopesOverlap = (a: string, b: string): boolean => isWithinScope(a, [b]) || isWithinScope(b, [a]);
