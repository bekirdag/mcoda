export class TaskApiResolver {
  constructor(private baseUrl?: string) {}

  private getBaseUrl(): string | undefined {
    return this.baseUrl ?? process.env.MCODA_API_BASE_URL ?? process.env.MCODA_TASKS_API_URL;
  }

  async resolveTaskId(taskKey: string, projectKey?: string): Promise<string | undefined> {
    const base = this.getBaseUrl();
    if (!base) return undefined;
    try {
      const url = new URL("/tasks", base);
      url.searchParams.set("key", taskKey);
      if (projectKey) {
        url.searchParams.set("project", projectKey);
      }
      const resp = await fetch(url, { headers: { accept: "application/json" } });
      if (!resp.ok) return undefined;
      const body = await resp.json();
      const candidates: any[] = Array.isArray(body)
        ? body
        : Array.isArray(body?.tasks)
          ? body.tasks
          : Array.isArray(body?.data)
            ? body.data
            : [];
      if (!candidates.length) return undefined;
      if (candidates.length > 1 && !projectKey) {
        throw new Error(`Multiple tasks found with key "${taskKey}" via OpenAPI; please specify --project.`);
      }
      const taskId = candidates[0]?.id ?? candidates[0]?.task_id;
      return typeof taskId === "string" ? taskId : undefined;
    } catch {
      return undefined;
    }
  }
}
