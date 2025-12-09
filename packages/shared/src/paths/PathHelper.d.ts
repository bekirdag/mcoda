/**
 * Utility helpers for resolving mcoda paths in both global and workspace scopes.
 * The helpers intentionally avoid touching any other layer to keep shared free of deps.
 */
export declare class PathHelper {
    static getGlobalMcodaDir(): string;
    static getGlobalDbPath(): string;
    static getWorkspaceDir(cwd?: string): string;
    static getWorkspaceDbPath(cwd?: string): string;
    static ensureDir(dir: string): Promise<void>;
}
//# sourceMappingURL=PathHelper.d.ts.map