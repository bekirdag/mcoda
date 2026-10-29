// Runs only inside the OS sandbox. Bundled at build time; no dynamic library loading.
import fs from 'node:fs';
import Decimal from 'decimal.js';
import Ajv from 'ajv';
import { det, inv, multiply, transpose, lusolve, mean, median, std, sum, dot, cross } from 'mathjs';
import decimalPackage from 'decimal.js/package.json' with { type: 'json' };
import ajvPackage from 'ajv/package.json' with { type: 'json' };
import mathPackage from 'mathjs/package.json' with { type: 'json' };

function integer(value, low, high) {
  if (!Number.isInteger(value) || value < low || value > high) throw Error(`Expected integer ${low}..${high}`);
  return value;
}
function decimal(value, D) {
  if (typeof value !== 'string' || value.length > 512 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d{1,4})?$/i.test(value)) throw Error('Use bounded decimal strings, never binary floats');
  const result = new D(value);
  if (!result.isFinite() || Math.abs(result.e) > 1000) throw Error('Decimal exponent out of range');
  return result;
}
function decimalOperation(a) {
  const precision = integer(a.precision ?? 50, 1, 200);
  const D = Decimal.clone({ precision, rounding: Decimal.ROUND_HALF_EVEN });
  if (!Array.isArray(a.values) || a.values.length < 1 || a.values.length > 64) throw Error('Use 1..64 operands');
  const values = a.values.map(v => decimal(v, D));
  const unary = { sqrt: x => x.sqrt(), abs: x => x.abs(), round: x => x.toDecimalPlaces(integer(a.places ?? 0, 0, 200)) };
  const binary = { add: (x,y) => x.plus(y), subtract: (x,y) => x.minus(y), multiply: (x,y) => x.times(y), divide: (x,y) => x.dividedBy(y), pow: (x,y) => {
    if (!y.isInteger() || y.abs().greaterThan(1000)) throw Error('Power exponent must be an integer within -1000..1000');
    return x.pow(y);
  } };
  let value;
  if (Object.hasOwn(unary, a.operation) && values.length === 1) value = unary[a.operation](values[0]);
  else if (Object.hasOwn(binary, a.operation) && values.length >= 2 && (a.operation !== 'pow' || values.length === 2)) value = values.slice(1).reduce(binary[a.operation], values[0]);
  else throw Error('Unknown operation or wrong operand count');
  if (!value.isFinite()) throw Error('Operation has no finite decimal result');
  return { result: value.toString(), precision, rounding: 'half_even', library: 'decimal.js', version: decimalPackage.version, semantics: 'Decimal arithmetic rounded to the reported significant-digit precision' };
}
function numericalOperation(a) {
  const functions = { det, inv, multiply, transpose, lusolve, mean, median, std, sum, dot, cross };
  if (!Object.hasOwn(functions, a.operation) || !Array.isArray(a.args) || !a.args.length || a.args.length > 2) throw Error('Unsupported numerical operation or operand count');
  let cells = 0;
  const check = (v, depth = 0) => {
    if (Array.isArray(v) && depth < 2 && v.length > 0 && v.length <= 64) { v.forEach(x => check(x, depth + 1)); return; }
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e100 || ++cells > 4096) throw Error('Use bounded finite numbers, vectors or matrices');
  };
  a.args.forEach(v => check(v));
  const result = functions[a.operation](...a.args);
  return { result: result?.toArray ? result.toArray() : result, library: 'mathjs', version: mathPackage.version, semantics: 'IEEE-754 numerical computation; inspect conditioning and rounding for sensitive work' };
}
function validateJson(a) {
  let nodes = 0;
  const check = (v, depth = 0) => {
    if (++nodes > 2048 || depth > 24) throw Error('Schema exceeds structural bounds');
    if (v && typeof v === 'object') for (const [key, value] of Object.entries(v)) {
      if (key === '$async' || key === '$data') throw Error('Asynchronous schemas and data references are unavailable');
      if (key === '$ref' && (typeof value !== 'string' || !value.startsWith('#'))) throw Error('Only local schema references are available');
      check(value, depth + 1);
    }
  };
  check(a.schema);
  const ajv = new Ajv({ allErrors: false, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false, validateFormats: false, loopRequired: 64, loopEnum: 64 });
  const validate = ajv.compile(a.schema);
  const valid = validate(a.data);
  return { valid, errors: validate.errors ?? [], library: 'ajv', version: ajvPackage.version, dialect: 'JSON Schema draft-07', formatsValidated: false, dataMutated: false };
}

try {
  const input = JSON.parse(fs.readFileSync('input.json', 'utf8'));
  const handlers = { decimal_calculate: decimalOperation, numerical_calculate: numericalOperation, validate_json: validateJson };
  if (!Object.hasOwn(handlers, input.tool)) throw Error('Unknown deterministic tool');
  const result = handlers[input.tool](input.args);
  const output = JSON.stringify(result, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Result contains a non-finite number');
    return value;
  });
  if (output.length > 96000) throw Error('Result exceeds output limit');
  process.stdout.write(output);
} catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message ?? error).slice(0, 1000) })); }
