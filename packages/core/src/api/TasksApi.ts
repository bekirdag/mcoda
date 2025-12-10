import { RefineTasksRequest, RefineTasksResult } from "@mcoda/shared";
import { WorkspaceResolver } from "../workspace/WorkspaceManager.js";
import { RefineTasksService } from "../services/planning/RefineTasksService.js";

export class TasksApi {
  static async refineTasks(request: RefineTasksRequest & { workspaceRoot?: string }): Promise<RefineTasksResult> {
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: request.workspaceRoot,
    });
    const service = await RefineTasksService.create(workspace);
    try {
      return await service.refineTasks({
        workspace,
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.userStoryKey,
        taskKeys: request.taskKeys,
        statusFilter: request.statusFilter,
        maxTasks: request.maxTasks,
        strategy: request.strategy,
        agentName: request.agentIdOverride,
        agentStream: true,
        fromDb: true,
        dryRun: request.dryRun,
        planInPath: request.planInPath,
        planOutPath: request.planOutPath,
        jobId: undefined,
        outputJson: false,
      });
    } finally {
      await service.close();
    }
  }
}
