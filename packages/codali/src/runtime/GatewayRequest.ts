const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Recover redundant gateway envelopes without guessing a tool or argument.
 * The caller must still check availability, permissions, schemas and batches.
 * Never apply this to another native tool's legitimate argument object. */
export function normalizeGatewayRequest(input: unknown): Record<string, unknown> {
  let value = input;
  for (let depth = 0; depth < 3 && object(value); depth++) {
    const keys = Object.keys(value).sort().join(",");
    if (keys === "args,name" && value.name === "codali" && object(value.args)) {
      value = value.args;
    } else if (keys === "args" && object(value.args) && Object.keys(value.args).sort().join(",") === "args,name") {
      value = value.args;
    } else break;
  }
  // The gateway has only name and args, so a named request without args is
  // the tool's own arguments written beside its name (cycle 7: browser_open's
  // url next to name inside a codali-named envelope). The name is explicit.
  if (object(value) && typeof value.name === "string" && value.name !== "codali" && !("args" in value) && Object.keys(value).length > 1) {
    const { name, ...args } = value;
    value = { name, args };
  }
  return object(value) ? value : {};
}

export interface ShapeTool { name: string; inputSchema?: Record<string, unknown>; }
const declares = (tool: ShapeTool | undefined, key: string) => object(tool?.inputSchema?.properties) && key in (tool!.inputSchema!.properties as Record<string, unknown>);

/** A native tool called with the gateway envelope around its own arguments:
 * T({name:"T", args:A}) or T({name:"T", ...A}). Unwrapped only when the name
 * repeats the called tool and its schema takes no `name` (or `args`) argument. */
export function unwrapSelfEnvelope(toolName: string, args: unknown, tool: ShapeTool | undefined): Record<string, unknown> | undefined {
  if (!tool || !object(args) || args.name !== toolName || declares(tool, "name")) return;
  if (Object.keys(args).sort().join(",") === "args,name" && object(args.args) && !declares(tool, "args")) return args.args;
  const { name: _name, ...rest } = args;
  return rest;
}

const keyList = (args: unknown) => object(args) ? Object.keys(args).slice(0, 8) : [];
const callExample = (name: string, keys: string[], native: boolean) => {
  const inner = `{${keys.map(key => `${key}:…`).join(", ")}}`;
  return native ? `${name}(${inner})` : `codali({name:"${name}", args:${inner}})`;
};

/** Explain a rejected interaction call: what is wrong and the corrected call.
 * `direct` are the tools callable by their own name this turn; `targets` are
 * the tools a codali envelope may name. `native` tells whether declared tools
 * are called directly (true) or only through the codali gateway. */
export function interactionCallProblem(callName: string, request: Record<string, unknown>, direct: string[], targets: ShapeTool[], native: boolean, raw?: unknown): string {
  const listed = (items: string[]) => `${items.slice(0, 40).join(", ")}${items.length > 40 ? ", …" : ""}`;
  if (!direct.includes(callName)) {
    if (!native && direct.includes("codali") && targets.some(tool => tool.name === callName)) {
      return `"${callName}" was called directly, but this turn reaches tools only through codali, so nothing ran. Corrected call: ${callExample(callName, keyList(object(request.args) ? request.args : request), false)}.`;
    }
    return callName === "codali"
      ? `"codali" is not declared in this turn, so nothing ran. Call a declared tool directly by its own name with its own arguments, for example ${callExample(direct.find(name => !["final_answer", "start_work"].includes(name)) ?? "final_answer", ["…"], true)}. Declared tools: ${listed(direct)}.`
      : `"${callName}" is not declared in this turn, so nothing ran. Load it first with tools_describe({names:["${callName}"]}) if it exists, or use a declared tool. Declared tools: ${listed(direct)}.`;
  }
  const name = request.name;
  const tools = `Tool names: ${listed(targets.map(tool => tool.name))}.`;
  if (typeof name !== "string" || !name || name === "codali") {
    // Suggest, never execute: tools whose schema accepts every supplied key.
    const keys = keyList(object(request.args) ? request.args : Object.fromEntries(Object.entries(request).filter(([key]) => key !== "name")));
    const fits = keys.length ? targets.filter(tool => keys.every(key => declares(tool, key))).map(tool => tool.name) : [];
    const target = fits.length === 1 ? fits[0] : "<tool name>";
    const directly = native && fits.length === 1 && direct.includes(target);
    return `This codali call names no tool to run${name === "codali" || object(raw) && raw.name === "codali" ? ': "codali" is the gateway itself, not a tool name' : ""}, so nothing ran. Put the tool's name in name and its arguments in args: codali({name:"${target}", args:{${keys.map(key => `${key}:…`).join(", ")}}})${directly ? `, or call it directly as ${callExample(target, keys, true)}` : ""}.${fits.length > 1 ? ` Tools that accept these arguments: ${fits.join(", ")}.` : ""} ${tools}`;
  }
  if (!object(request.args)) return `${name}: args must be an object of ${name}'s arguments, so nothing ran. Corrected call: ${callExample(name, ["…"], false)}.`;
  const extra = Object.keys(request).filter(key => !["name", "args"].includes(key));
  return `${name}: the keys ${extra.join(", ")} were given beside name and args, so nothing ran. Put every argument inside args: ${callExample(name, [...keyList(request.args), ...extra], false)}.`;
}
