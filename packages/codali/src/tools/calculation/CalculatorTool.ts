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

/** A numeric grammar, not JavaScript: every character is consumed, and nothing is evaluated as code. */
const tokenize = (expression: string): string[] => {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 4096) throw new Error("Expected an expression of 1 to 4096 characters");
  const pattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Math\.[A-Za-z_][A-Za-z_0-9]*|[A-Za-z_][A-Za-z_0-9]*|\*\*|[+*/%^(),=;-]/y;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(expression);
    if (!match) throw new Error(`Unsupported character at position ${offset + 1}`);
    offset = pattern.lastIndex;
    // Literal aliases enter the same bounded grammar; no object lookup or code execution.
    const token = match[0].startsWith("Math.") ? match[0].slice(5) : match[0];
    if (token.trim()) tokens.push(token);
    if (tokens.length > 1024) throw new Error("Expression exceeds 1024 tokens");
  }
  return tokens;
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
  ["round", { min: 1, max: 1, run: Math.round }],
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
    else if (token === "pi" || token === "PI") value = Math.PI;
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

const MAX_STATEMENTS = 64;

/** A calculation script: statements separated by ";" or line breaks, each either
 * `name = formula` or a bare formula. Names are numbers held in a Map and can be
 * used by later statements. Still the numeric grammar above: no code runs.
 * The models write multi-step arithmetic this way; refusing it cost a round
 * trip on about one calculator call in three. */
export const evaluateCalculationScript = (script: string, options: CalculationOptions = {}): { result: number; values: Record<string, number> } => {
  if (typeof script !== "string" || !script.trim() || script.length > 4096) throw new Error("Expected an expression of 1 to 4096 characters");
  const statements = script.split(/[;\n]/).map(part => part.trim()).filter(Boolean);
  if (!statements.length) throw new Error("Expected an expression of 1 to 4096 characters");
  if (statements.length > MAX_STATEMENTS) throw new Error(`A calculation holds at most ${MAX_STATEMENTS} statements`);
  const variables = new Map<string, number>(options.variables ?? []);
  const values = new Map<string, number>();
  let result = NaN;
  const previous = inexactInteger;
  inexactInteger = options.onInexactInteger;
  try {
    for (const statement of statements) {
      const tokens = tokenize(statement);
      if (tokens[1] === "=") {
        const name = tokens[0];
        if (!variableName(name)) throw new Error(`${name} cannot be assigned: a name starts with a letter and holds letters, digits or _`);
        if (tokens.indexOf("=", 2) !== -1) throw new Error("One assignment per statement");
        result = evaluateTokens(tokens.slice(2), variables);
        variables.set(name, result); values.set(name, result);
      } else {
        if (tokens.includes("=")) throw new Error("Assignments take the form name = formula");
        result = evaluateTokens(tokens, variables);
      }
    }
  } finally { inexactInteger = previous; }
  return { result: result === 0 ? 0 : result, values: Object.fromEntries(values) };
};

const ARITHMETIC = "IEEE-754 double; not exact decimal arithmetic";
const INEXACT = "An integer above 2^53 was rounded to about 16 significant digits; use decimal_calculate where every digit matters";

export const createCalculatorTool = (): ToolDefinition => ({
  name: "calculate", capability: "calculation", readOnly: true,
  description: "Calculate {expression:'formula'} OR {expressions:{label:'formula'}} (up to 64). An expression may hold several statements separated by ; with names: 'r1 = 6778; v = sqrt(398600/r1); v*2'. In expressions, a later formula may use an earlier label as a number. Supports exp,ln/log(natural),log2,log10,pow,sqrt,cbrt,hypot,sin/cos/tan,asin/acos/atan/atan2,sinh/cosh/tanh (radians),abs,floor,ceil,round,trunc,sign,min,max,sum,comb/C(n,k),perm/P(n,k),factorial; + - * / %, ^ **, pi,e. Math.function aliases accepted only for this allowlist. Numbers only: no strings, lists, loops, imports or code. IEEE-754 approximate; exact decimals use decimal_calculate. Tool success checks arithmetic, not whether your formula models the request.",
  inputSchema: { type: "object", properties: { expression: { type: "string", description: "A numeric formula, e.g. exp(-2)*3, or statements separated by ; such as 'a = 2*3; b = a+4; b/2'. Supply this OR expressions.", minLength: 1, maxLength: 4096 },
    expressions: { type: "object", description: "Map labels to complete formula STRINGS, e.g. {total:'2*3+4',check:'10'}. A formula may use the label of an earlier formula as a number. Supply this OR expression.", minProperties: 1, maxProperties: 64, propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }, additionalProperties: true },
  }, oneOf: [{ required: ["expression"] }, { required: ["expressions"] }], additionalProperties: false },
  handler: async (args, context) => {
    context.signal?.throwIfAborted();
    try {
      const input = args as { expression?: string; expressions?: Record<string, string> };
      if (!input || typeof input !== "object" || Array.isArray(input) || input.expression === undefined && input.expressions === undefined) throw new Error('Use {"expression":"2+3"} or {"expressions":{"total":"2+3"}}; formulas must be strings');
      let inexact = false;
      const options = { onInexactInteger: () => { inexact = true; } };
      const note = () => inexact ? { arithmetic: ARITHMETIC, warning: INEXACT } : { arithmetic: ARITHMETIC };
      if (input.expressions !== undefined) {
        if (input.expression !== undefined) throw new Error("Supply expression or expressions, not both");
        if (!input.expressions || typeof input.expressions !== "object" || Array.isArray(input.expressions) || Object.keys(input.expressions).length < 1 || Object.keys(input.expressions).length > MAX_STATEMENTS) throw new Error(`Supply 1 to ${MAX_STATEMENTS} named expressions`);
        const variables = new Map<string, number>();
        const results: Record<string, number> = {};
        for (const [label, expression] of Object.entries(input.expressions)) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(label)) throw new Error("Invalid calculation label");
          if (typeof expression !== "string") throw new Error(`Formula ${label} must be a string such as "2*3+4"`);
          const value = evaluateCalculation(expression, { ...options, variables });
          results[label] = value;
          if (variableName(label)) variables.set(label, value);
        }
        return { output: JSON.stringify({ results, ...note() }) };
      }
      if (typeof input.expression !== "string") throw new Error('Use {"expression":"2+3"}; the formula must be a string');
      const { result, values } = evaluateCalculationScript(input.expression, options);
      return { output: JSON.stringify(Object.keys(values).length ? { result, values, ...note() } : { result, ...note() }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolExecutionError("tool_invalid_args", `${message}. Correct the arguments before retrying; use tools_describe for the schema. Numbers, names (a = 2*3; a+1) and the listed functions only; strings, lists, loops and imports need a code tool such as verify_javascript.`, { retryable: false });
    }
  },
});
