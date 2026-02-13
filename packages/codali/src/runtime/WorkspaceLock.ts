import { promises as fs } from "node:fs";
import path from "node:path";

export interface WorkspaceLockInfo {
  runId: string;
  acquiredAt: number;
}

export interface WorkspaceLockSignalOptions {
  exitOnSignal?: boolean;
  onSignal?: (signal: NodeJS.Signals) => void | Promise<void>;
  exitCodeForSignal?: (signal: NodeJS.Signals) => number;
}

export class WorkspaceLock {
  private lockPath: string;
  private acquired = false;

  constructor(
    private workspaceRoot: string,
    private runId: string,
    private maxAgeMs: number = 60 * 60 * 1000,
  ) {
    this.lockPath = path.join(this.workspaceRoot, "locks", "codali.lock");
  }

  private async readLock(): Promise<WorkspaceLockInfo | undefined> {
    try {
      const raw = await fs.readFile(this.lockPath, "utf8");
      return JSON.parse(raw) as WorkspaceLockInfo;
    } catch {
      return undefined;
    }
  }

  private isStale(info: WorkspaceLockInfo): boolean {
    return Date.now() - info.acquiredAt > this.maxAgeMs;
  }

  async acquire(): Promise<void> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    const existing = await this.readLock();
    if (existing && !this.isStale(existing)) {
      throw new Error(`Workspace is locked by run ${existing.runId}`);
    }
    if (existing && this.isStale(existing)) {
      await fs.unlink(this.lockPath).catch(() => undefined);
    }
    const payload: WorkspaceLockInfo = { runId: this.runId, acquiredAt: Date.now() };
    await fs.writeFile(this.lockPath, JSON.stringify(payload, null, 2), "utf8");
    this.acquired = true;
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    const existing = await this.readLock();
    if (existing?.runId && existing.runId !== this.runId) {
      return;
    }
    await fs.unlink(this.lockPath).catch(() => undefined);
    this.acquired = false;
  }

  registerSignalHandlers(options: WorkspaceLockSignalOptions = {}): () => void {
    const exitOnSignal = options.exitOnSignal ?? true;
    const exitCodeForSignal =
      options.exitCodeForSignal ?? ((signal: NodeJS.Signals) => (signal === "SIGTERM" ? 143 : 130));
    let handled = false;
    const listeners = new Map<NodeJS.Signals, () => void>();
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGTSTP", "SIGQUIT", "SIGHUP"];

    const handler = (signal: NodeJS.Signals) => {
      if (handled) return;
      handled = true;
      const releasePromise = this.release().catch(() => undefined);
      // Fire and forget any extra signal handling to avoid delaying unlock/exit.
      Promise.resolve(options.onSignal?.(signal)).catch(() => undefined);
      releasePromise.finally(() => {
        if (exitOnSignal) {
          process.exitCode = exitCodeForSignal(signal);
          process.exit();
        }
      });
    };

    for (const signal of signals) {
      const listener = () => handler(signal);
      listeners.set(signal, listener);
      process.once(signal, listener);
    }

    return () => {
      for (const [signal, listener] of listeners.entries()) {
        process.off(signal, listener);
      }
      listeners.clear();
    };
  }
}
