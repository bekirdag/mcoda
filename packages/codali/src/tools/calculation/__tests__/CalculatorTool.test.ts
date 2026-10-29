import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCalculation, createCalculatorTool } from "../CalculatorTool.js";
import { PermissionGate, permissionKind } from "../../../permissions/PermissionGate.js";
import { toolDescriptorFor } from "../../ToolRegistry.js";

test("calculator handles precedence, numeric notation, functions and units expressed as arithmetic", () => {
  for (const [expression, expected] of [
    ["2 + 3 * 4", 14], ["(2 + 3) * 4", 20], ["2^3^2", 512], ["-2**2", -4], ["2^-3", 0.125],
    ["12 / 3 / 2", 2], [".5 + 1. + 2e-2", 1.52], ["sum(2, 3*4, -1)", 13],
    ["sqrt(81)+abs(-2)+ceil(1.1)+floor(1.9)", 14], ["min(2,5,-3)+max(1,8)", 5],
    ["(17*3+29*2)/(3+2)", 21.8], ["(2*60+15)*60", 8100], ["round(-1.5)", -1], ["-7 % 3", -1],
  ] as const) assert.equal(evaluateCalculation(expression), expected, expression);
  assert.ok(Math.abs(evaluateCalculation("pi * 2") - 2 * Math.PI) < 1e-12);
});

test("calculator rejects unsupported code, incomplete syntax and ambiguous implicit operations", () => {
  for (const expression of ["", "   ", "1 2", "2(3)", "1e", "1e+", "1..2", "sum(1,)", "abs()", "abs(1,2)",
    "(1+2", "1+2)", "1;2", "1//2", "1/*x*/+2", "globalThis", "process.env", "require('fs')", "import('fs')",
    "constructor(1)", "__proto__(1)", "(()=>1)()", "[1,2]", "{a:1}", "x=1", "Math.sqrt(4)", "sqrt(4).constructor", "1\u0000+2"]) {
    assert.throws(() => evaluateCalculation(expression), Error, expression);
  }
});

test("calculator refuses nonfinite results, unsafe integers and resource exhaustion", () => {
  for (const expression of ["1/0", "0/0", "1%0", "sqrt(-1)", "(-1)^.5", "1e309", "9007199254740993", "2^53",
    "sum(9007199254740991,1)", " ".repeat(4096) + "1", "1+".repeat(520) + "1", "(".repeat(40) + "1" + ")".repeat(40),
    "-".repeat(40) + "1", "sum(" + Array(129).fill("1").join(",") + ")"]) assert.throws(() => evaluateCalculation(expression), Error, expression);
});

test("calculator passes independent bounded integer arithmetic checks", () => {
  for (let a = -9; a <= 9; a++) for (let b = 1; b <= 9; b++) {
    assert.equal(evaluateCalculation(`(${a}+${b})*(${a}-${b})`), a * a - b * b);
    assert.equal(evaluateCalculation(`(${a}*${b}+${b})/${b}`), a + 1);
  }
});

test("calculator is pure read permission, honors denial and cancellation, and labels precision", async () => {
  const tool = createCalculatorTool();
  const descriptor = toolDescriptorFor(tool);
  assert.equal(permissionKind(descriptor), "read");
  await new PermissionGate("plan").authorize(descriptor, { expression: "1+2" });
  await assert.rejects(new PermissionGate("plan", undefined, { deniedTools: ["calculate"] }).authorize(descriptor, {}), /denied/);
  assert.equal(permissionKind({ ...descriptor, readOnly: false }), "external");
  const result = await tool.handler({ expression: "1+2" }, { workspaceRoot: "/unused" });
  assert.deepEqual(JSON.parse(result.output), { result: 3, arithmetic: "IEEE-754 double; not exact decimal arithmetic" });
  await assert.rejects(tool.handler({ expression: "1/0" }, { workspaceRoot: "/unused" }), /undefined/);
  await assert.rejects(tool.handler({ expression: "1+2" }, { workspaceRoot: "/unused", signal: AbortSignal.abort(new Error("Stopped")) }), /Stopped/);
});
