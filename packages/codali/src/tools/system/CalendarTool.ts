import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

interface CalendarInput { operation: "add_days" | "difference_days"; date: string; days?: number; otherDate?: string; }
const DAY = 86_400_000;
const epochDay = (date: string): number => {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) throw new Error("Expected a Gregorian date YYYY-MM-DD in years 0001–9999");
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new Error("Invalid calendar date");
  return time / DAY;
};

export const calendarCalculate = (input: CalendarInput): { date: string } | { days: number } => {
  const start = epochDay(input.date);
  if (input.operation === "add_days") {
    if (!Number.isInteger(input.days) || Math.abs(input.days!) > 3_652_058 || input.otherDate !== undefined) throw new Error("add_days requires integer days and no otherDate");
    const date = new Date((start + input.days!) * DAY).toISOString().slice(0, 10);
    epochDay(date); // Reject results beyond the supported Gregorian year range.
    return { date };
  }
  if (input.operation === "difference_days") {
    if (input.days !== undefined || input.otherDate === undefined) throw new Error("difference_days requires otherDate and no days");
    return { days: epochDay(input.otherDate) - start };
  }
  throw new Error("Unknown calendar operation");
};

export const createCalendarTool = (): ToolDefinition => ({
  name: "calendar_calculate", capability: "calculation", readOnly: true,
  description: "Exact Gregorian calendar dates: add signed days or count otherDate minus date. ISO YYYY-MM-DD, UTC; no business-day, locale or timezone guessing.",
  inputSchema: { type: "object", required: ["operation", "date"], additionalProperties: false, properties: {
    operation: { type: "string", enum: ["add_days", "difference_days"] }, date: { type: "string", minLength: 10, maxLength: 10 },
    days: { type: "integer", minimum: -3_652_058, maximum: 3_652_058 }, otherDate: { type: "string", minLength: 10, maxLength: 10 },
  } },
  handler: async (args, context) => {
    context.signal?.throwIfAborted();
    try { const data = { ...calendarCalculate(args as CalendarInput), calendar: "proleptic Gregorian UTC" }; return { output: JSON.stringify(data), data }; }
    catch (error) { throw new ToolExecutionError("tool_invalid_args", error instanceof Error ? error.message : String(error), { retryable: false }); }
  },
});
