import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JobsCommands } from "../commands/jobs/JobsCommands.js";
import { JobInsightsService, JobService, JobResumeService } from "@mcoda/core";

const originalApiBase = process.env.MCODA_API_BASE_URL;
if (!originalApiBase) {
  process.env.MCODA_API_BASE_URL = "http://localhost";
}
const originalJobsApiBase = process.env.MCODA_JOBS_API_URL;
if (!originalJobsApiBase) {
  process.env.MCODA_JOBS_API_URL = process.env.MCODA_API_BASE_URL;
}

const withPatched = <T, K extends keyof T>(target: T, key: K, impl: T[K], fn: () => Promise<void> | void) => {
  const original = target[key];
  // @ts-ignore override for testing
  target[key] = impl;
  return (async () => {
    try {
      await fn();
    } finally {
      // @ts-ignore restore original
      target[key] = original;
    }
  })();
};

const captureLogs = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  // @ts-ignore override
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
  }
  return logs;
};

describe("job command behavior", () => {
  it("returns non-zero exit for failed status", async () => {
    const finishCalls: Array<{ status: string; error?: string }> = [];
    const getJob = async () => ({ id: "job-1", type: "work", state: "failed", commandName: "work-on-tasks" });
    const latestCheckpoint = async () => undefined;
    await withPatched(JobInsightsService.prototype as any, "getJob", getJob as any, async () => {
      await withPatched(JobInsightsService.prototype as any, "latestCheckpoint", latestCheckpoint as any, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-1" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string, error?: string) => {
            finishCalls.push({ status, error });
          }, async () => {
            const originalExit = process.exitCode;
            process.exitCode = undefined;
            await JobsCommands.run(["status", "job-1"]);
            assert.equal(process.exitCode, 1);
            assert.equal(finishCalls.at(-1)?.status, "failed");
            process.exitCode = originalExit;
          });
        });
      });
    });
  });

  it("watch exits on completed without error", async () => {
    const getJob = async () => ({ id: "job-2", type: "work", state: "completed", commandName: "work-on-tasks" });
    const latestCheckpoint = async () => undefined;
    const finishes: string[] = [];
    await withPatched(JobInsightsService.prototype as any, "getJob", getJob as any, async () => {
      await withPatched(JobInsightsService.prototype as any, "latestCheckpoint", latestCheckpoint as any, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-2" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string) => {
            finishes.push(status);
          }, async () => {
            const originalExit = process.exitCode;
            process.exitCode = undefined;
            await JobsCommands.run(["watch", "job-2", "--interval", "1", "--no-logs"]);
            assert.equal(process.exitCode ?? 0, 0);
            assert.equal(finishes.at(-1), "succeeded");
            process.exitCode = originalExit;
          });
        });
      });
    });
  });

  it("resume fails when no checkpoints exist", async () => {
    const finishCalls: Array<{ status: string; error?: string }> = [];
    await withPatched(JobResumeService.prototype as any, "resume", async () => {
      throw new Error("No checkpoints");
    }, async () => {
      await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-3" }), async () => {
        await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string, error?: string) => {
          finishCalls.push({ status, error });
        }, async () => {
          const originalExit = process.exitCode;
          process.exitCode = undefined;
          await JobsCommands.run(["resume", "job-3"]);
          assert.equal(process.exitCode, 1);
          assert.match(finishCalls.at(-1)?.error ?? "", /No checkpoints/);
          process.exitCode = originalExit;
        });
      });
    });
  });

  it("cancel rejects non-cancellable without --force", async () => {
    const getJob = async () => ({ id: "job-4", type: "work", state: "completed", commandName: "work-on-tasks" });
    const finishCalls: Array<{ status: string; error?: string }> = [];
    await withPatched(JobInsightsService.prototype as any, "getJob", getJob as any, async () => {
      await withPatched(JobService.prototype as any, "updateJobStatus", async () => {}, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-4" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string, error?: string) => {
            finishCalls.push({ status, error });
          }, async () => {
            const originalExit = process.exitCode;
            process.exitCode = undefined;
            await JobsCommands.run(["cancel", "job-4"]);
            assert.equal(process.exitCode, 1);
            assert.match(finishCalls.at(-1)?.error ?? "", /rerun with --force/);
            process.exitCode = originalExit;
          });
        });
      });
    });
  });

  it("list succeeds with rows", async () => {
    const finishCalls: Array<{ status: string; error?: string }> = [];
    await withPatched(JobInsightsService.prototype as any, "listJobs", async () => [
      { id: "job-10", type: "review", jobState: "running", jobStateDetail: "working", totalUnits: 10, completedUnits: 5, commandName: "code-review" },
    ], async () => {
      await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-10" }), async () => {
        await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string, error?: string) => {
          finishCalls.push({ status, error });
        }, async () => {
          await JobsCommands.run(["list"]);
          assert.equal(finishCalls.at(-1)?.status, "succeeded");
        });
      });
    });
  });

  it("list --json emits SDS-shaped fields", async () => {
    const finishes: string[] = [];
    await withPatched(JobInsightsService.prototype as any, "listJobs", async () => [
      { id: "job-json", type: "review", jobState: "running", jobStateDetail: "detail", totalUnits: 2, completedUnits: 1, commandName: "code-review", createdAt: "now" },
    ], async () => {
      await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-10b" }), async () => {
        await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string) => {
          finishes.push(status);
        }, async () => {
          const logs = await captureLogs(async () => {
            await JobsCommands.run(["list", "--json"]);
          });
          const parsed = JSON.parse(logs.join("\n"));
          assert.equal(parsed[0].jobState ?? parsed[0].job_state, "running");
          assert.equal(parsed[0].jobStateDetail ?? parsed[0].job_state_detail, "detail");
          assert.equal(parsed[0].completedUnits ?? parsed[0].completed_units, 1);
          assert.equal(parsed[0].createdAt ?? parsed[0].created_at, "now");
          assert.equal(finishes.at(-1), "succeeded");
        });
      });
    });
  });

  it("logs prints entries once without follow", async () => {
    const finishes: string[] = [];
    await withPatched(JobInsightsService.prototype as any, "getJobLogs", async () => ({ entries: [{ timestamp: "t1", message: "m1" }], cursor: undefined }), async () => {
      await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-logs" }), async () => {
        await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string) => {
          finishes.push(status);
        }, async () => {
          await JobsCommands.run(["logs", "job-logs"]);
          assert.equal(finishes.at(-1), "succeeded");
        });
      });
    });
  });

  it("logs --follow polls until terminal and sets exit code on failure", async () => {
    const finishes: string[] = [];
    const logCalls: string[] = [];
    let jobPoll = 0;
    await withPatched(JobInsightsService.prototype as any, "getJobLogs", async () => {
      logCalls.push("logs");
      if (logCalls.length === 1) return { entries: [{ timestamp: "t1", message: "m1" }], cursor: { timestamp: "t1" } };
      return { entries: [{ timestamp: "t2", message: "m2" }], cursor: { timestamp: "t2" } };
    }, async () => {
      await withPatched(JobInsightsService.prototype as any, "getJob", async () => {
        jobPoll += 1;
        return { id: "job-follow", state: jobPoll === 1 ? "running" : "failed" };
      }, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-logs-follow" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string) => {
            finishes.push(status);
          }, async () => {
            const originalExit = process.exitCode;
            process.exitCode = undefined;
            const logs = await captureLogs(async () => {
              await JobsCommands.run(["logs", "job-follow", "--follow", "--interval", "1"]);
            });
            assert(logs.some((l) => l.includes("t1")));
            assert(logs.some((l) => l.includes("t2")));
            assert.equal(process.exitCode, 1);
            assert.equal(finishes.at(-1), "succeeded");
            process.exitCode = originalExit;
          });
        });
      });
    });
  });

  it("inspect succeeds with checkpoint/tasks/tokens", async () => {
    const finishes: string[] = [];
    await withPatched(JobInsightsService.prototype as any, "getJob", async () => ({
      id: "job-inspect",
      type: "review",
      jobState: "completed",
      commandName: "code-review",
    }), async () => {
      await withPatched(JobInsightsService.prototype as any, "latestCheckpoint", async () => ({ stage: "done", timestamp: "now" }), async () => {
        await withPatched(JobInsightsService.prototype as any, "summarizeTasks", async () => ({ totals: { completed: 1 }, tasks: [] }), async () => {
          await withPatched(JobInsightsService.prototype as any, "summarizeTokenUsage", async () => [{ agentId: "a1", modelName: "m1", tokensTotal: 10 }], async () => {
            await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-inspect" }), async () => {
              await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string) => {
                finishes.push(status);
              }, async () => {
                await JobsCommands.run(["inspect", "job-inspect"]);
                assert.equal(finishes.at(-1), "succeeded");
              });
            });
          });
        });
      });
    });
  });

  it("status --json includes job_state detail and checkpoint", async () => {
    const finishes: string[] = [];
    await withPatched(JobInsightsService.prototype as any, "getJob", async () => ({
      id: "job-json-status",
      type: "review",
      jobState: "running",
      jobStateDetail: "working",
      totalUnits: 4,
      completedUnits: 2,
      commandName: "code-review",
    }), async () => {
      await withPatched(JobInsightsService.prototype as any, "latestCheckpoint", async () => ({ stage: "stage-x", timestamp: "ts" }), async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-status" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string) => {
            finishes.push(status);
          }, async () => {
            const logs = await captureLogs(async () => {
              await JobsCommands.run(["status", "job-json-status", "--json"]);
            });
            const payload = JSON.parse(logs.join("\n"));
            assert.equal(payload.job.job_state, "running");
            assert.equal(payload.job.job_state_detail, "working");
            assert.equal(payload.job.completed_units, 2);
            assert.equal(payload.checkpoint.stage, "stage-x");
            assert.equal(finishes.at(-1), "succeeded");
          });
        });
      });
    });
  });

  it("resume succeeds when manifest matches", async () => {
    const finishes: string[] = [];
    let resumeCalled = 0;
    await withPatched(JobResumeService.prototype as any, "resume", async () => {
      resumeCalled += 1;
    }, async () => {
      await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-resume" }), async () => {
        await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string) => {
          finishes.push(status);
        }, async () => {
          await JobsCommands.run(["resume", "job-resume"]);
          assert.equal(resumeCalled, 1);
          assert.equal(finishes.at(-1), "succeeded");
        });
      });
    });
  });

  it("cancel succeeds in running state", async () => {
    const finishes: string[] = [];
    await withPatched(JobInsightsService.prototype as any, "getJob", async () => ({
      id: "job-cancel",
      type: "review",
      jobState: "running",
      commandName: "code-review",
    }), async () => {
      await withPatched(JobInsightsService.prototype as any, "cancelJob", async () => {}, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-cancel" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async (_id: string, status: string) => {
            finishes.push(status);
          }, async () => {
            await JobsCommands.run(["cancel", "job-cancel"]);
            assert.equal(finishes.at(-1), "succeeded");
          });
        });
      });
    });
  });
});
