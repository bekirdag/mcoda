import { WorkspaceResolver } from "../workspace/WorkspaceManager.js";
import { QaTasksService, QaTasksRequest, QaTasksResponse } from "../services/execution/QaTasksService.js";

export class QaTasksApi {
  static async runQa(
    request: Partial<QaTasksRequest> & { workspaceRoot?: string; noTelemetry?: boolean },
  ): Promise<QaTasksResponse> {
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: request.workspaceRoot,
      noRepoWrites: true,
    });
    const service = await QaTasksService.create(workspace, { noTelemetry: request.noTelemetry ?? false });
    try {
      return await service.run({
        workspace,
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.storyKey,
        taskKeys: request.taskKeys,
        statusFilter: request.statusFilter,
        mode: request.mode,
        resumeJobId: request.resumeJobId,
        profileName: request.profileName,
        level: request.level,
        testCommand: request.testCommand,
        agentName: request.agentName,
        agentStream: request.agentStream,
        rateAgents: request.rateAgents,
        createFollowupTasks: request.createFollowupTasks,
        dryRun: request.dryRun,
        result: request.result,
        notes: request.notes,
        evidenceUrl: request.evidenceUrl,
        allowDirty: request.allowDirty,
        cleanIgnorePaths: request.cleanIgnorePaths,
      });
    } finally {
      await service.close();
    }
  }
}
