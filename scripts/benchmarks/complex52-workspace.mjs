// Dedicated fresh-study provisioning; no app-only instructions leak into answer tasks.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { provisionAppWorkspace as provisionBuild } from './appbuild-workspace.mjs';
export { snapshotWorkflowWorkspace, excludedNames } from './appbuild-workspace.mjs';
export async function provisionAppWorkspace(workspace, task) {
  if (task.comparison === 'implementation') return provisionBuild(workspace, task);
  await fs.writeFile(path.join(workspace, 'ENVIRONMENT.md'), '# Evaluation environment\nAnswer the user request. Workspace files are read-only evidence. Discoverable deterministic, document, repository, time and browser tools are available. Public web access is permitted only when requested in the task. Do not create an application or modify files for an answer task. Do not access host credentials.\n');
  await fs.writeFile(path.join(workspace, '.docdexignore'), 'node_modules/\n.git/\n');
}
