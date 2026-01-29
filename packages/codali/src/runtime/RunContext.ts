export class RunContext {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly startedAt: number;
  private touchedFiles = new Set<string>();

  constructor(runId: string, workspaceRoot: string) {
    this.runId = runId;
    this.workspaceRoot = workspaceRoot;
    this.startedAt = Date.now();
  }

  recordTouchedFile(filePath: string): void {
    this.touchedFiles.add(filePath);
  }

  getTouchedFiles(): string[] {
    return Array.from(this.touchedFiles).sort();
  }
}
