import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCalculation, createCalculatorTool } from "../CalculatorTool.js";
import { PermissionGate, permissionKind } from "../../../permissions/PermissionGate.js";
import { ToolRegistry, toolDescriptorFor } from "../../ToolRegistry.js";

test("scientific functions retain numeric grammar, domains and arity boundaries", () => {
  for (const [formula, expected] of [
    ["Math.exp(0)", 1], ["Math.max(2,5)", 5], ["Math.sqrt(9)", 3], ["Math.sin(Math.PI/2)", 1], ["exp(0)", 1], ["ln(e)", 1], ["log(e^2)", 2], ["log10(1000)", 3],
    ["sin(pi/2)", 1], ["cos(pi)", -1], ["tan(0)", 0], ["pow(3,4)", 81],
    ["exp(ln(7.25))", 7.25], ["sin(.7)^2+cos(.7)^2", 1],
  ] as const) assert.ok(Math.abs(evaluateCalculation(formula) - expected) < 1e-12, formula);
  for (const formula of ["ln(0)", "ln(-2)", "log10(-1)", "exp(1000)", "pow(-1,.5)",
    "pow(2)", "pow(2,3,4)", "exp()", "ln(2,3)", "Math.random()", "Math.constructor(2)", "Math.max.constructor(2)", "x=exp(2)"]) {
    assert.throws(() => evaluateCalculation(formula), Error, formula);
  }
});

test("malformed calculator calls explain a valid recoverable shape", async () => {
  const registry = new ToolRegistry(); registry.register(createCalculatorTool());
  const failed = await registry.execute("calculate", {}, { workspaceRoot: "." });
  assert.equal(failed.ok, false);
  assert.match(failed.error!.message, /expression.*2\+3/);
  const corrected = await registry.execute("calculate", { expressions: { decay: "exp(-ln(2))", check: "1/2" } }, { workspaceRoot: "." });
  assert.equal(corrected.ok, true);
  assert.deepEqual(JSON.parse(corrected.output).results, { decay: .5, check: .5 });
});

test("calculator batches named formulas atomically without allowing code or ambiguous inputs", async () => {
  const registry = new ToolRegistry(); registry.register(createCalculatorTool());
  const run = (args: unknown) => registry.execute("calculate", args, { workspaceRoot: "." });
  const result = await run({ expressions: { total: "18*7", ratio: "(3*8)/(3*8+2*4)" } });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(JSON.parse(result.output).results, { total: 126, ratio: 0.75 });
  for (const args of [{}, { expression: "1", expressions: { a: "2" } }, { expressions: {} },
    { expressions: { a: "1", b: "process.env" } }, { expressions: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`a${i}`, "1"])) }]) {
    assert.equal((await run(args)).ok, false);
  }
});

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
    "constructor(1)", "__proto__(1)", "(()=>1)()", "[1,2]", "{a:1}", "x=1", "Math['sqrt'](4)", "sqrt(4).constructor", "1\u0000+2"]) {
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

test("counting functions give exact binomial coefficients and permutations", () => {
  assert.equal(evaluateCalculation("C(40,8)"), 76904685);
  assert.equal(evaluateCalculation("comb(38,7) + nCr(5,6)"), 12620256);
  assert.equal(evaluateCalculation("perm(5,2)"), 20);
  assert.equal(evaluateCalculation("factorial(10)"), 3628800);
  assert.ok(Math.abs(evaluateCalculation("0.3*2*C(38,7)/C(40,8) + 0.2*6*C(34,7)/C(40,8)") - 0.182404) < 1e-6);
  assert.throws(() => evaluateCalculation("C(4.5,2)"), /non-negative integers/);
});
