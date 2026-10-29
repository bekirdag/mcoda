import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

const finite = (value: number): number => {
  if (!Number.isFinite(value)) throw new Error("Calculation is undefined or exceeds finite numeric range");
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("Integer exceeds exact supported range");
  return value;
};

/** A numeric grammar, not JavaScript: every character is consumed, and nothing is evaluated as code. */
const tokenize = (expression: string): string[] => {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 4096) throw new Error("Expected an expression of 1 to 4096 characters");
  const pattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|\*\*|[+*/%^(),-]/y;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(expression);
    if (!match) throw new Error(`Unsupported character at position ${offset + 1}`);
    offset = pattern.lastIndex;
    if (match[0].trim()) tokens.push(match[0]);
    if (tokens.length > 1024) throw new Error("Expression exceeds 1024 tokens");
  }
  return tokens;
};

const functions = new Map<string, { min: number; max: number; run: (...args: number[]) => number }>([
  ["abs", { min: 1, max: 1, run: Math.abs }],
  ["sqrt", { min: 1, max: 1, run: Math.sqrt }],
  ["floor", { min: 1, max: 1, run: Math.floor }],
  ["ceil", { min: 1, max: 1, run: Math.ceil }],
  ["round", { min: 1, max: 1, run: Math.round }],
  ["min", { min: 1, max: 128, run: Math.min }],
  ["max", { min: 1, max: 128, run: Math.max }],
  ["sum", { min: 1, max: 128, run: (...args) => args.reduce((total, value) => finite(total + value), 0) }],
]);

/** Bounded Pratt parser; exponentiation is right associative and binds more tightly than unary minus. */
export const evaluateCalculation = (expression: string): number => {
  const tokens = tokenize(expression);
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
    else if (token === "pi") value = Math.PI;
    else if (token === "e") value = Math.E;
    else {
      const fn = functions.get(token);
      if (!fn) throw new Error(`Expected a number or supported function, received ${token ?? "end of expression"}`);
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

export const createCalculatorTool = (): ToolDefinition => ({
  name: "calculate", capability: "calculation", readOnly: true,
  description: "Evaluate a numeric expression. Supports + - * / %, powers ^ or **, parentheses, pi, e, abs/sqrt/floor/ceil/round (one argument), min/max/sum (1-128 comma-separated arguments). % is signed remainder; round ties toward positive infinity. IEEE-754 floating-point, not exact decimal arithmetic; unsafe integers rejected. No variables, code, files or network. Use observed results to check arithmetic; you remain responsible for choosing the right formula and units.",
  inputSchema: { type: "object", properties: { expression: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["expression"], additionalProperties: false },
  handler: async (args, context) => {
    context.signal?.throwIfAborted();
    try {
      const result = evaluateCalculation((args as { expression: string }).expression);
      return { output: JSON.stringify({ result, arithmetic: "IEEE-754 double; not exact decimal arithmetic" }) };
    } catch (error) {
      throw new ToolExecutionError("tool_invalid_args", error instanceof Error ? error.message : String(error), { retryable: false });
    }
  },
});
