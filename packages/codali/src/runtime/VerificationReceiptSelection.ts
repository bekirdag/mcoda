import { isVerificationCommand } from "./VerificationCommand.js";

interface CheckReceipt {
  id: string;
  taskId?: string;
  attemptId?: string;
  tool: string;
  status: string;
  args: unknown;
  inputHashes: Record<string, string>;
}

/** Select distinct checks from one attempt and one observed workspace snapshot.
 * This is evidence selection only: the controller still checks current files
 * and independently reviews every assigned requirement before accepting work. */
export function automaticVerificationReceipts<T extends CheckReceipt>(receipts: T[], taskId: string, attemptId: string): T[] {
  const checks = receipts.filter(receipt => receipt.taskId === taskId && receipt.attemptId === attemptId
    && receipt.tool === "run_shell" && isVerificationCommand(receipt.args)).reverse();
  const latest = checks[0];
  if (!latest) return [];
  if (latest.status !== "success") throw new Error("The latest check in this task attempt did not succeed. Resolve its failure and rerun the check before verification.");
  const snapshot = (receipt: T) => JSON.stringify(Object.entries(receipt.inputHashes).sort(([a], [b]) => a.localeCompare(b)));
  const latestSnapshot = snapshot(latest);
  const seen = new Set<string>(); const selected: T[] = [];
  for (const receipt of checks) {
    const args = receipt.args as { command: string; args?: string[]; cwd?: string };
    const command = JSON.stringify([args.command, args.args ?? [], args.cwd ?? "."]);
    if (seen.has(command)) continue;
    seen.add(command); // A newer failed check cannot uncover an older success.
    if (receipt.status !== "success" || snapshot(receipt) !== latestSnapshot) continue;
    selected.push(receipt);
    if (selected.length === 10) break;
  }
  return selected;
}
