/**
 * Utility helpers for resolving mcoda paths in both global and workspace scopes.
 * The helpers intentionally avoid touching any other layer to keep shared free of deps.
 */
export declare class PathHelper {
    static normalizePathCase(value: string): string;
    static resolveRelativePath(root: string, target: string): string;
    static isPathInside(root: string, target: string): boolean;
    static getGlobalMcodaDir(): string;
    static getGlobalDbPath(): string;
    static getGlobalWorkspaceDir(workspaceRoot: string): string;
    static getWorkspaceDir(workspaceRoot?: string): string;
    static getWorkspaceDbPath(workspaceRoot?: string): string;
    static ensureDir(dir: string): Promise<void>;
}
//# sourceMappingURL=PathHelper.d.ts.map
