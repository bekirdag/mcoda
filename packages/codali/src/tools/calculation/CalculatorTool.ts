import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

/** Set while a caller accepts integers beyond 2^53 as rounded doubles (capacity
 * arithmetic such as bytes per year); without it they are refused as inexact. */
let inexactInteger: (() => void) | undefined;
const finite = (value: number): number => {
  if (!Number.isFinite(value)) throw new Error("Calculation is undefined or exceeds finite numeric range");
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    if (!inexactInteger) throw new Error("Integer exceeds exact supported range");
    inexactInteger();
  }
  return value;
};

const MAX_SCRIPT_CHARS = 32_000;
/** A numeric grammar, not JavaScript: every character is consumed, and nothing is evaluated as code. */
const tokenize = (expression: string): string[] => {
  if (typeof expression !== "string" || !expression.trim() || expression.length > MAX_SCRIPT_CHARS) throw new Error(`Expected an expression of 1 to ${MAX_SCRIPT_CHARS} characters`);
  const pattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|(?:Math|math)\.[A-Za-z_][A-Za-z_0-9]*|[A-Za-z_][A-Za-z_0-9]*|\*\*|[+*/%^(),=;[\]-]/y;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(expression);
    if (!match) throw new Error(`Unsupported character ${JSON.stringify(expression[offset])} at position ${offset + 1} of ${quoted(expression)}${unsupportedHint(expression[offset])}`);
    offset = pattern.lastIndex;
    // Literal aliases (JavaScript Math.x, Python math.x) enter the same bounded grammar; no object lookup or code execution.
    const token = /^(?:Math|math)\./.test(match[0]) ? match[0].slice(5) : match[0];
    if (token.trim()) tokens.push(token);
    if (tokens.length > 1024) throw new Error("Expression exceeds 1024 tokens");
  }
  return tokens;
};

/** Statement text for an error message. */
const quoted = (statement: string): string => JSON.stringify(statement.length > 80 ? `${statement.slice(0, 77)}...` : statement);
/** How to say the same thing in this grammar. */
const unsupportedHint = (char: string): string => char === "{" ? ": use the expressions argument for named formulas"
  : `"'`.includes(char) ? ": formulas hold numbers and names only, no strings"
  : ["<", ">", "!", "&", "|", "?"].includes(char) ? ": comparisons and conditions need code; run it with run_code" : "";
/** Error function, |error| < 1e-15: a Taylor series near zero, a continued fraction in the tails. */
const erf = (x: number): number => {
  if (Number.isNaN(x)) return x;
  const z = Math.abs(x);
  if (z > 6) return Math.sign(x);
  if (z < 2.5) {
    let term = z, sum = z;
    for (let n = 1; n < 200; n++) { term *= -z * z / n; const next = term / (2 * n + 1); sum += next; if (Math.abs(next) < 1e-17 * Math.abs(sum)) break; }
    return Math.sign(x) * 2 / Math.sqrt(Math.PI) * sum;
  }
  return Math.sign(x) * (1 - erfcTail(z));
};
/** erfc for z >= 2.5 by Lentz's continued fraction, accurate where 1 - erf loses digits. */
const erfcTail = (z: number): number => {
  const tiny = 1e-300;
  let f = z, c = z, d = 0;
  for (let n = 1; n < 500; n++) {
    const a = n / 2;
    d = z + a * d; d = Math.abs(d) < tiny ? tiny : d; d = 1 / d;
    c = z + a / c; c = Math.abs(c) < tiny ? tiny : c;
    const delta = c * d; f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-z * z) / Math.sqrt(Math.PI) / f;
};
const erfc = (x: number): number => x >= 2.5 ? erfcTail(x) : 1 - erf(x);
/** Python's round: the nearest value with n decimal places, ties to even, decided
 * on the exact binary value (round(2.675, 2) is 2.67 because 2.675 is stored a
 * hair below the tie; round(2.5) is 2). The same answer run_code's Python gives. */
const roundTo = (value: number, places = 0): number => {
  if (!Number.isInteger(places) || places < -15 || places > 15) throw new Error("round(x, n) takes a whole number of places from -15 to 15");
  if (places < 0) return roundTo(value / 10 ** -places, 0) * 10 ** -places;
  const magnitude = Math.abs(value);
  if (magnitude >= 1e21) return value;
  // toFixed rounds the exact binary value and takes the larger candidate on a tie.
  const up = magnitude.toFixed(places), exact = magnitude.toFixed(100);
  const point = exact.indexOf("."), tail = exact.slice(point + 1 + places);
  let result = Number(up);
  if (/^50*$/.test(tail) && Number(up.replace(".", "").at(-1)) % 2 === 1) result = Number((result - 10 ** -places).toFixed(places));
  return Math.sign(value) * result === 0 ? 0 : Math.sign(value) * result;
};

const countArgs = (n: number, k: number): void => {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0) throw new Error("Counting functions take non-negative integers");
};
/** n choose k, exact while the result is a safe integer (each partial product is). */
const combinations = (n: number, k: number): number => {
  countArgs(n, k);
  if (k > n) return 0;
  let result = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) result = finite(result * (n - Math.min(k, n - k) + i) / i);
  return Math.round(result);
};
const permutations = (n: number, k: number): number => {
  countArgs(n, k);
  if (k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = finite(result * (n - i));
  return result;
};

const functions = new Map<string, { min: number; max: number; run: (...args: number[]) => number }>([
  ["abs", { min: 1, max: 1, run: Math.abs }],
  ["sqrt", { min: 1, max: 1, run: Math.sqrt }],
  ["exp", { min: 1, max: 1, run: Math.exp }],
  ["ln", { min: 1, max: 1, run: Math.log }],
  ["log", { min: 1, max: 1, run: Math.log }],
  ["log10", { min: 1, max: 1, run: Math.log10 }],
  ["sin", { min: 1, max: 1, run: Math.sin }],
  ["cos", { min: 1, max: 1, run: Math.cos }],
  ["tan", { min: 1, max: 1, run: Math.tan }],
  // Orbit, heading and angle questions were answered from memory after asin,
  // acos, atan and atan2 were each refused.
  ["asin", { min: 1, max: 1, run: Math.asin }],
  ["acos", { min: 1, max: 1, run: Math.acos }],
  ["atan", { min: 1, max: 1, run: Math.atan }],
  ["atan2", { min: 2, max: 2, run: Math.atan2 }],
  ["sinh", { min: 1, max: 1, run: Math.sinh }],
  ["cosh", { min: 1, max: 1, run: Math.cosh }],
  ["tanh", { min: 1, max: 1, run: Math.tanh }],
  ["log2", { min: 1, max: 1, run: Math.log2 }],
  ["cbrt", { min: 1, max: 1, run: Math.cbrt }],
  ["hypot", { min: 1, max: 128, run: Math.hypot }],
  ["trunc", { min: 1, max: 1, run: Math.trunc }],
  ["sign", { min: 1, max: 1, run: Math.sign }],
  ["pow", { min: 2, max: 2, run: Math.pow }],
  ["floor", { min: 1, max: 1, run: Math.floor }],
  ["ceil", { min: 1, max: 1, run: Math.ceil }],
  ["round", { min: 1, max: 2, run: roundTo }],
  // Normal-distribution work (option pricing, z-scores) was done from memory after erf was refused.
  ["erf", { min: 1, max: 1, run: erf }],
  ["erfc", { min: 1, max: 1, run: erfc }],
  ["normcdf", { min: 1, max: 1, run: (x: number) => 0.5 * erfc(-x / Math.SQRT2) }],
  ["normpdf", { min: 1, max: 1, run: (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) }],
  ["min", { min: 1, max: 128, run: Math.min }],
  ["max", { min: 1, max: 128, run: Math.max }],
  ["sum", { min: 1, max: 128, run: (...args) => args.reduce((total, value) => finite(total + value), 0) }],
  // Counting functions: hypergeometric and sampling questions need them, and a
  // rejected C(40,8) made the model type binomial coefficients from memory.
  ...["comb", "choose", "nCr", "C"].map(name => [name, { min: 2, max: 2, run: combinations }] as const),
  ...["perm", "nPr", "P"].map(name => [name, { min: 2, max: 2, run: permutations }] as const),
  ["factorial", { min: 1, max: 1, run: (n: number) => permutations(n, n) }],
]);

const variableName = (name: string | undefined): name is string => !!name && /^[A-Za-z][A-Za-z_0-9]{0,63}$/.test(name);

export interface CalculationOptions {
  /** Values usable by name. A Map, so no object or prototype lookup can occur. */
  variables?: ReadonlyMap<string, number>;
  /** Accept integers beyond 2^53 as rounded doubles and report that it happened. */
  onInexactInteger?: () => void;
}

/** Bounded Pratt parser; exponentiation is right associative and binds more tightly than unary minus. */
export const evaluateCalculation = (expression: string, options: CalculationOptions = {}): number => {
  const tokens = tokenize(expression);
  if (tokens.includes("=") || tokens.includes(";")) throw new Error("One formula only; assignments and several statements belong in a calculation script");
  const previous = inexactInteger;
  inexactInteger = options.onInexactInteger;
  try { return evaluateTokens(tokens, options.variables); } finally { inexactInteger = previous; }
};

const evaluateTokens = (tokens: string[], variables?: ReadonlyMap<string, number>): number => {
  let position = 0;
  const expect = (token: string) => {
    if (tokens[position++] !== token) throw new Error(`Expected ${token}`);
  };
  const parse = (precedence = 0, depth = 0): number => {
    if (depth > 32) throw new Error("Expression nesting exceeds 32 levels");
    const token = tokens[position++];
    let value: number;
    if (token === "+" || token === "-") {
      const operand = parse(25, depth + 1);
      value = token === "-" ? -operand : operand;
    } else if (token === "(") {
      value = parse(0, depth + 1); expect(")");
    } else if (token && /^(?:\d|\.)/.test(token)) value = finite(Number(token));
    // An assigned name wins over a constant or function of the same spelling:
    // e is an eccentricity and P a pressure as often as they are e and nPr.
    else if (token && variables?.has(token) && tokens[position] !== "(") value = variables.get(token)!;
    // pi() as Python and spreadsheet users write it.
    else if (token === "pi" || token === "PI") { value = Math.PI; if (tokens[position] === "(" && tokens[position + 1] === ")") position += 2; }
    else if (token === "e" || token === "E") value = Math.E;
    else {
      const fn = functions.get(token);
      if (!fn) throw new Error(variableName(token) ? `Unknown name ${token}: assign it first (${token} = ...) or use a supported function`
        : `Expected a number or supported function, received ${token ?? "end of expression"}`);
      expect("(");
      const args: number[] = [];
      if (tokens[position] !== ")") {
        do {
          if (args.length >= fn.max) throw new Error(`${token} accepts at most ${fn.max} arguments`);
          args.push(parse(0, depth + 1));
          if (tokens[position] !== ",") break;
          position++;
        } while (true);
      }
      expect(")");
      if (args.length < fn.min) throw new Error(`${token} requires at least ${fn.min} argument`);
      value = finite(fn.run(...args));
    }
    while (position < tokens.length) {
      const operator = tokens[position];
      const power = operator === "^" || operator === "**";
      const binding = power ? 30 : ["*", "/", "%"].includes(operator) ? 20 : ["+", "-"].includes(operator) ? 10 : 0;
      if (binding === 0 || binding <= precedence) break;
      position++;
      const right = parse(power ? binding - 1 : binding, depth + 1);
      switch (operator) {
        case "+": value += right; break;
        case "-": value -= right; break;
        case "*": value *= right; break;
        case "/": value /= right; break;
        case "%": value %= right; break;
        default: value **= right;
      }
      value = finite(value);
    }
    return finite(value);
  };
  const result = parse();
  if (position !== tokens.length) throw new Error(`Unexpected token ${tokens[position]}`);
  // JSON has a single zero representation; keep the exported numeric API consistent.
  return result === 0 ? 0 : result;
};

/** A fixed-point iteration or a 12-step recurrence written out takes a few hundred statements. */
const MAX_STATEMENTS = 1000;
const MAX_LABELS = 256;
const SEPARATOR_HINT = "write numbers without thousands separators (1000, not 1,000), or list several results in brackets, such as [a, b]";
/** A statement that lists values must be bracketed: [a, b, c]. A comma anywhere
 * else at the top level is refused, never read as a list: "1,000 * 3" is a
 * thousands separator, and reading it as [1, 0] would be a wrong success. */
const listItems = (tokens: string[]): string[][] | undefined => {
  const split = (inner: string[]) => {
    const items: string[][] = []; let depth = 0, current: string[] = [];
    for (const token of inner) {
      if (token === "(" || token === "[") depth++;
      else if (token === ")" || token === "]") depth--;
      if (token === "," && depth === 0) { items.push(current); current = []; } else current.push(token);
    }
    items.push(current);
    return items;
  };
  let enclosing = tokens[0] === "[" && tokens.at(-1) === "]";
  if (enclosing) {
    let depth = 0;
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] === "(" || tokens[index] === "[") depth++;
      else if (tokens[index] === ")" || tokens[index] === "]") depth--;
      if (depth === 0 && index < tokens.length - 1) { enclosing = false; break; }
    }
  }
  if (!enclosing) {
    // (a, b) or a, b: a comma outside any function call.
    const top = split(tokens);
    const grouped = tokens[0] === "(" && tokens.at(-1) === ")" && split(tokens.slice(1, -1)).length > 1;
    if (top.length > 1 || grouped) throw new Error(`A comma outside a function call is not a list: ${SEPARATOR_HINT}`);
    return undefined;
  }
  const items = split(tokens.slice(1, -1));
  if (items.some(item => !item.length || item.includes("[") || item.includes("]"))) throw new Error("A result list holds formulas separated by commas, such as [a, b, a*b]; lists cannot be nested or empty");
  // [12,500] is far more often twelve thousand five hundred than two values.
  for (let index = 1; index < items.length; index++) {
    if (items[index].length >= 1 && /^\d{3}$/.test(items[index][0]) && /^\d+$/.test(items[index - 1].at(-1) ?? "")) throw new Error(`Ambiguous list item ${items[index - 1].at(-1)},${items[index][0]}: ${SEPARATOR_HINT}`);
  }
  return items;
};

/** A calculation script: statements separated by ";" or line breaks, each either
 * `name = formula` or a bare formula. Names are numbers held in a Map and can be
 * used by later statements. Still the numeric grammar above: no code runs.
 * The models write multi-step arithmetic this way; refusing it cost a round
 * trip on about one calculator call in three. */
export const evaluateCalculationScript = (script: string, options: CalculationOptions = {}): { result: number | number[]; values: Record<string, number> } => {
  if (typeof script !== "string" || !script.trim() || script.length > MAX_SCRIPT_CHARS) throw new Error(`Expected an expression of 1 to ${MAX_SCRIPT_CHARS} characters`);
  // A line break separates statements only outside parentheses, so a formula may wrap.
  const statements: string[] = []; let depth = 0, piece = "";
  for (const char of script) {
    if (char === "(") depth++; else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === ";" || char === "\n" && depth === 0) { statements.push(piece); piece = ""; } else piece += char === "\n" ? " " : char;
  }
  statements.push(piece);
  for (let index = statements.length - 1; index >= 0; index--) { statements[index] = statements[index].trim(); if (!statements[index]) statements.splice(index, 1); }
  if (!statements.length) throw new Error("Expected an expression of 1 to 4096 characters");
  if (statements.length > MAX_STATEMENTS) throw new Error(`A calculation holds at most ${MAX_STATEMENTS} statements; for longer iterations write a loop and run it with run_code`);
  const variables = new Map<string, number>(options.variables ?? []);
  const values = new Map<string, number>();
  let result: number | number[] = NaN;
  const previous = inexactInteger;
  inexactInteger = options.onInexactInteger;
  try {
    for (const [index, statement] of statements.entries()) {
      try {
        const tokens = tokenize(statement);
        if (tokens[1] === "=") {
          const name = tokens[0];
          if (!variableName(name)) throw new Error(`${name} cannot be assigned: a name starts with a letter and holds letters, digits or _`);
          if (tokens.indexOf("=", 2) !== -1) throw new Error("One assignment per statement");
          if (tokens.includes("[") || listItems(tokens.slice(2))) throw new Error("A name holds one number; list several results in the last statement instead, such as [a, b, c]");
          const value = evaluateTokens(tokens.slice(2), variables);
          variables.set(name, value); values.set(name, value); result = value;
        } else {
          if (tokens.includes("=")) throw new Error("Assignments take the form name = formula");
          const items = listItems(tokens);
          result = items ? items.map(item => { const value = evaluateTokens(item, variables); return value === 0 ? 0 : value; }) : evaluateTokens(tokens, variables);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(statements.length > 1 ? `Statement ${index + 1} of ${statements.length} (${quoted(statement)}): ${message}` : message);
      }
    }
  } finally { inexactInteger = previous; }
  return { result: typeof result === "number" && result === 0 ? 0 : result, values: Object.fromEntries(values) };
};

const ARITHMETIC = "IEEE-754 double; not exact decimal arithmetic";
/** Names that are constants until a calculation assigns them. */
const CONSTANT_NAMES = new Set(["e", "E", "pi", "PI"]);
const shadowNote = (names: string[]): string | undefined => {
  const shadowed = names.filter(name => CONSTANT_NAMES.has(name));
  return shadowed.length ? `${shadowed.join(", ")} ${shadowed.length > 1 ? "were" : "was"} given a value here, so later formulas use that value, not the constant (${shadowed.map(name => name.toLowerCase() === "e" ? "Euler's number: use exp(x)" : "pi: use acos(-1)").join("; ")}).` : undefined;
};
const INEXACT = "An integer above 2^53 was rounded to about 16 significant digits; use decimal_calculate where every digit matters";

export const createCalculatorTool = (): ToolDefinition => ({
  name: "calculate", capability: "calculation", readOnly: true,
  description: `Calculate {expression:'formula'} OR {expressions:{label:'formula'}} (up to ${MAX_LABELS}). An expression may hold up to ${MAX_STATEMENTS} statements separated by ; or line breaks, with names: 'r1 = 6778; v = sqrt(398600/r1); [v, v*2]'; a final [a, b] returns each value; write numbers without thousands separators. In expressions, labels may use each other in any order. Supports exp,ln/log(natural),log2,log10,pow,sqrt,cbrt,hypot,sin/cos/tan,asin/acos/atan/atan2,sinh/cosh/tanh (radians),abs,floor,ceil,round(x) and round(x,n) (Python: ties to even),trunc,sign,min,max,sum,erf,erfc,normcdf,normpdf,comb/C(n,k),perm/P(n,k),factorial; + - * / %, ^ **, pi (or pi()), e. Math.x and math.x aliases accepted for this allowlist. Numbers only: loops, conditions, strings and imports need run_code. IEEE-754 approximate; exact decimals use decimal_calculate. Tool success checks arithmetic, not whether your formula models the request.`,
  inputSchema: { type: "object", properties: { expression: { type: "string", description: "A numeric formula, e.g. exp(-2)*3, or statements separated by ; such as 'a = 2*3; b = a+4; [a, b, b/2]'. Supply this OR expressions.", minLength: 1, maxLength: MAX_SCRIPT_CHARS },
    expressions: { type: "object", description: "Map labels to complete formula STRINGS, e.g. {total:'base*3+4',base:'2'}. A formula may use any other label as a number. Supply this OR expression.", minProperties: 1, maxProperties: MAX_LABELS, propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }, additionalProperties: true },
  }, oneOf: [{ required: ["expression"] }, { required: ["expressions"] }], additionalProperties: false },
  handler: async (args, context) => {
    context.signal?.throwIfAborted();
    try {
      const input = args as { expression?: string; expressions?: Record<string, string> };
      if (!input || typeof input !== "object" || Array.isArray(input) || input.expression === undefined && input.expressions === undefined) throw new Error('Use {"expression":"2+3"} or {"expressions":{"total":"2+3"}}; formulas must be strings');
      let inexact = false;
      const options = { onInexactInteger: () => { inexact = true; } };
      let assigned: string[] = [];
      const note = () => { const warnings = [inexact ? INEXACT : undefined, shadowNote(assigned)].filter(Boolean); return warnings.length ? { arithmetic: ARITHMETIC, warning: warnings.join(" ") } : { arithmetic: ARITHMETIC }; };
      if (input.expressions !== undefined) {
        if (input.expression !== undefined) throw new Error("Supply expression or expressions, not both");
        if (!input.expressions || typeof input.expressions !== "object" || Array.isArray(input.expressions) || Object.keys(input.expressions).length < 1 || Object.keys(input.expressions).length > MAX_LABELS) throw new Error(`Supply 1 to ${MAX_LABELS} named expressions`);
        const entries = Object.entries(input.expressions);
        for (const [label, expression] of entries) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(label)) throw new Error("Invalid calculation label");
          if (typeof expression !== "string") throw new Error(`Formula ${label} must be a string such as "2*3+4"`);
        }
        // Labels resolve in dependency order, so a formula may use a label written
        // after it ("Unknown name H17" cost three raw-arm calls in cycle 7); the
        // results keep the order they were given in.
        const variables = new Map<string, number>();
        let pending = entries;
        while (pending.length) {
          const waiting: typeof entries = [];
          for (const [label, expression] of pending) {
            // A label still waiting on another label (P before P is computed would read as perm P(n,k)).
            const names = (expression as string).replace(/\b(?:Math|math)\.[A-Za-z_]\w*/g, "").match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? [];
            if (names.some(name => name !== label && !variables.has(name) && pending.some(([other]) => other === name))) { waiting.push([label, expression]); continue; }
            try {
              variables.set(label, evaluateCalculation(expression as string, { ...options, variables }));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const unknown = message.match(/^Unknown name ([A-Za-z_][A-Za-z_0-9]*)/)?.[1];
              if (unknown && unknown !== label && pending.some(([other]) => other === unknown)) { waiting.push([label, expression]); continue; }
              throw new Error(`Formula ${label} (${quoted(String(expression))}): ${message}`);
            }
          }
          if (waiting.length === pending.length) throw new Error(`Formulas ${waiting.map(([label]) => label).join(", ")} depend on each other in a cycle; give one of them a number`);
          pending = waiting;
        }
        const results: Record<string, number> = Object.fromEntries(entries.map(([label]) => [label, variables.get(label)!]));
        assigned = Object.keys(results);
        return { output: JSON.stringify({ results, ...note() }) };
      }
      if (typeof input.expression !== "string") throw new Error('Use {"expression":"2+3"}; the formula must be a string');
      const { result, values } = evaluateCalculationScript(input.expression, options);
      assigned = Object.keys(values);
      return { output: JSON.stringify(Object.keys(values).length ? { result, values, ...note() } : { result, ...note() }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolExecutionError("tool_invalid_args", `${message}. Correct the arguments before retrying; use tools_describe for the schema. Write numbers, names (a = 2*3; a+1), the listed functions and, last, a result list such as [a, b]. Loops, conditions, strings and imports need code: run it with run_code (python or javascript) and print the values.`, { retryable: false });
    }
  },
});
