import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

/** The execution host's clock; never an inferred date or a model-server clock. */
export const createTimeTool = (now: () => number = Date.now): ToolDefinition => ({
  name: "server_time", capability: "clock", readOnly: true,
  description: "Read the current clock of the computer running Codali. Returns UTC, Unix milliseconds and an optional IANA timezone representation. Use for today's date, current time and resolving relative dates; this is not the remote model server's clock.",
  inputSchema: { type: "object", properties: { timezone: { type: "string", minLength: 1, maxLength: 128 } }, additionalProperties: false },
  handler: async (args, context) => {
    context.signal?.throwIfAborted();
    const timezone = (args as { timezone?: string }).timezone ?? "UTC";
    let formatter: Intl.DateTimeFormat;
    try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }); }
    catch { throw new ToolExecutionError("tool_invalid_args", "Use an IANA timezone such as UTC, Europe/London or Asia/Tokyo", { retryable: false }); }
    const unixMilliseconds = now();
    const data = { source: "Codali execution host clock", utc: new Date(unixMilliseconds).toISOString(), unixMilliseconds,
      timezone: formatter.resolvedOptions().timeZone, local: formatter.format(new Date(unixMilliseconds)) };
    return { output: JSON.stringify(data), data };
  },
});
