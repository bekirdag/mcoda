import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createDeterministicTools } from "../DeterministicTools.js";
import { ToolRegistry } from "../../ToolRegistry.js";
import { executorStatus } from "../../shell/IsolatedExecutor.js";
import { PermissionGate, permissionKind } from "../../../permissions/PermissionGate.js";
import { toolDescriptorFor } from "../../ToolRegistry.js";

const isolation = executorStatus();
const options = { skip: !isolation.available && isolation.reason };
const registry = new ToolRegistry();
for (const tool of createDeterministicTools()) registry.register(tool);
const run = (name: string, args: unknown, signal?: AbortSignal) => registry.execute(name, args, { workspaceRoot: os.tmpdir(), signal });
const data = async (name: string, args: unknown) => {
  const result = await run(name, args); assert.equal(result.ok, true, result.error?.message || result.output);
  const value = JSON.parse(result.output);
  assert.match(value.inputSha256, /^[a-f0-9]{64}$/); assert.match(value.workerSha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof value.version, "string"); return value;
};

test("decimal operations avoid binary float error and report finite precision", options, async () => {
  assert.equal((await data("decimal_calculate", { operation: "add", values: ["0.1", "0.2"] })).result, "0.3");
  assert.equal((await data("decimal_calculate", { operation: "divide", values: ["1", "3"], precision: 20 })).result, "0.33333333333333333333");
  assert.equal((await data("decimal_calculate", { operation: "round", values: ["2.5"] })).result, "2");
  assert.equal((await run("decimal_calculate", { operation: "divide", values: ["1", "0"] })).ok, false);
  assert.equal((await run("decimal_calculate", { operation: "add", values: [0.1, 0.2] })).ok, false);
});

test("math.js solves an independent linear system and reports numerical semantics", options, async () => {
  const result = await data("numerical_calculate", { operation: "lusolve", args: [[[2, 1], [1, 3]], [5, 5]] });
  assert.deepEqual(result.result, [[2], [1]]); assert.match(result.semantics, /IEEE-754/);
  assert.equal((await data("numerical_calculate", { operation: "det", args: [[[1, 2], [3, 4]]] })).result, -2);
  assert.equal((await run("numerical_calculate", { operation: "evaluate", args: ["process.env"] })).ok, false);
});

test("Ajv detects actual invalid data, does not coerce and rejects remote refs", options, async () => {
  const schema = { type: "object", properties: { age: { type: "integer", minimum: 0 } }, required: ["age"], additionalProperties: false };
  assert.equal((await data("validate_json", { schema, data: { age: 8 } })).valid, true);
  const invalid = await data("validate_json", { schema, data: { age: "8" } });
  assert.equal(invalid.valid, false); assert.equal(invalid.errors[0].instancePath, "/age");
  assert.equal((await run("validate_json", { schema: { $ref: "http://127.0.0.1/private" }, data: {} })).ok, false);
});

test("SymPy constructs exact expressions and validates supplied solutions", options, async () => {
  assert.equal((await data("symbolic_math", { operation: "differentiate", expression: "x**2 + 2*x + 1", symbols: ["x"], variable: "x" })).result, "2*x + 2");
  const solved = await data("symbolic_math", { operation: "solve", expression: "x**2 - 4", symbols: ["x"], variable: "x" });
  assert.deepEqual(solved.solutions, ["-2", "2"]); assert.deepEqual(solved.substitutionResiduals, ["0", "0"]);
  assert.equal((await data("symbolic_math", { operation: "simplify", expression: "0.1 + 0.2", symbols: [] })).result, "3/10");
  for (const expression of ["__import__('os').getcwd()", "x.__class__", "[x for x in (1,2)]", "unknown+1"]) {
    assert.equal((await run("symbolic_math", { operation: "simplify", expression, symbols: ["x"] })).ok, false, expression);
  }
});

test("Z3 separates satisfiable and inconsistent constraints and verifies the model", options, async () => {
  const sat = await data("solve_constraints", { variables: { x: "Int", y: "Int" }, constraints: ["x+y==7", "x==3"] });
  assert.equal(sat.status, "sat"); assert.deepEqual(sat.model, { x: "3", y: "4" }); assert.equal(sat.constraintsVerified, true);
  assert.equal((await data("solve_constraints", { variables: { x: "Int" }, constraints: ["x>5", "x<3"] })).status, "unsat");
  assert.equal((await run("solve_constraints", { variables: { x: "Int" }, constraints: ["x+1"] })).ok, false);
});

test("DuckDB aggregates exact decimals, preserves large integers and blocks external/mutating SQL", options, async () => {
  const tables = [{ name: "sales", columns: { amount: "DECIMAL(10,2)" }, rows: [["10.50"], ["20.25"], ["5.75"]] }];
  assert.deepEqual((await data("query_data", { sql: "SELECT sum(amount) FROM sales", tables })).rows, [["36.50"]]);
  assert.deepEqual((await data("query_data", { sql: "SELECT 9007199254740993::BIGINT", tables: [] })).rows, [["9007199254740993"]]);
  for (const sql of ["SELECT * FROM read_csv('/etc/passwd')", "SELECT * FROM read_csv('http://127.0.0.1:8734/private')", "COPY (SELECT 1) TO '/tmp/export'", "SELECT 1; SELECT 2", "SELECT random()", "ATTACH '/tmp/db' AS secret"]) {
    assert.equal((await run("query_data", { sql, tables: [] })).ok, false, sql);
  }
});

test("Polars groups and filters supplied rows and rejects arbitrary expressions", options, async () => {
  const rows = [{ team: "a", amount: 2 }, { team: "b", amount: 7 }, { team: "a", amount: 4 }];
  const output = await data("transform_data", { rows, steps: [
    { operation: "filter", column: "amount", comparison: "gt", value: 2 },
    { operation: "aggregate", by: ["team"], aggregations: [{ column: "amount", function: "sum", alias: "total" }] },
    { operation: "sort", columns: ["team"] },
  ] });
  assert.deepEqual(output.rows, [{ team: "a", total: 4 }, { team: "b", total: 7 }]);
  assert.equal((await run("transform_data", { rows, steps: [{ operation: "eval", code: "open('/etc/passwd')" }] })).ok, false);
});

test("deterministic tools honor explicit denials and cancellation", options, async () => {
  const tool = toolDescriptorFor(createDeterministicTools()[0]);
  assert.equal(permissionKind(tool), "read");
  await assert.rejects(new PermissionGate("workspace", undefined, { deniedTools: [tool.name] }).authorize(tool, {}), /explicitly denied/);
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(Error("cancel deterministic")), 20);
  try { await assert.rejects(run("symbolic_math", { operation: "expand", expression: "(x+y+z)**100", symbols: ["x", "y", "z"] }, abort.signal), /cancel deterministic/); }
  finally { clearTimeout(timer); }
});

test("DuckDB expected rows distinguish execution from exact example validation", options, async () => {
  const query = { sql: 'SELECT n FROM sample ORDER BY n', tables: [{ name: 'sample', columns: { n: 'DOUBLE' }, rows: [[2], [1], [1]] }] };
  assert.equal((await data('query_data', query)).validation, undefined);
  assert.equal((await data('query_data', { ...query, expectedRows: [[1], [1], [2]] })).validation.passed, true);
  assert.equal((await data('query_data', { ...query, expectedRows: [[2], [1], [1]] })).validation.passed, false);
  assert.equal((await data('query_data', { ...query, expectedRows: [[2], [1], [1]], rowOrder: 'unordered' })).validation.passed, true);
  assert.equal((await data('query_data', { ...query, expectedRows: [[2], [1]], rowOrder: 'unordered' })).validation.passed, false);
  assert.equal((await data('query_data', { ...query, expectedRows: [['1'], ['1'], ['2']] })).validation.passed, false);
  const empty = await data('query_data', { sql: 'SELECT NULL WHERE false', tables: [], expectedRows: [] });
  assert.equal(empty.validation.passed, true);
  const nullRow = await data('query_data', { sql: 'SELECT NULL', tables: [], expectedRows: [[null]] });
  assert.equal(nullRow.validation.passed, true);
  assert.match(nullRow.validation.scope, /provided examples only/);
});

test("SQL row binding is independent of JSON object key order and rejects ambiguity", async () => {
  const sql = 'SELECT first, second FROM sample';
  const columns = { second: 'DOUBLE', first: 'DOUBLE' };
  for (const table of [
    { name: 'sample', columns, rows: [{ first: 11, second: 22 }] },
    { name: 'sample', columns: { first: 'DOUBLE', second: 'DOUBLE' }, rows: [{ second: 22, first: 11 }] },
    { name: 'sample', columns, columnOrder: ['first', 'second'], rows: [[11, 22]] },
  ]) assert.deepEqual((await data('query_data', { sql, tables: [table] })).rows, [[11, 22]]);
  const ambiguous = await run('query_data', { sql, tables: [{ name: 'sample', columns, rows: [[11, 22]] }] });
  assert.equal(ambiguous.ok, false);
  assert.match(JSON.stringify(ambiguous), /columnOrder/);
  for (const table of [
    { rows: [[11, 22]], columnOrder: ['first', 'first'] },
    { rows: [[11, 22]], columnOrder: ['first', 'other'] },
    { rows: [[11, 22]], columnOrder: ['first'] },
    { rows: [{ first: 11 }] },
    { rows: [{ first: 11, second: 22, extra: 33 }] },
    { rows: [{ first: { nested: 11 }, second: 22 }] },
    { rows: [{ first: 11, second: 22 }, [11, 22]], columnOrder: ['first', 'second'] },
  ]) assert.equal((await run('query_data', { sql, tables: [{ name: 'sample', columns, ...table }] })).ok, false);
  assert.deepEqual((await data('query_data', { sql, tables: [{ name: 'sample', columns, rows: [] }] })).rows, []);
});
