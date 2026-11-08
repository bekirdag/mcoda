/** Recover redundant gateway envelopes without guessing a tool or argument.
 * The caller must still check availability, permissions, schemas and batches.
 * Never apply this to another native tool's legitimate argument object. */
export function normalizeGatewayRequest(input: unknown): Record<string, unknown> {
  let value = input;
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  for (let depth = 0; depth < 3 && object(value); depth++) {
    const keys = Object.keys(value).sort().join(",");
    if (keys === "args,name" && value.name === "codali" && object(value.args)) {
      value = value.args;
    } else if (keys === "args" && object(value.args) && Object.keys(value.args).sort().join(",") === "args,name") {
      value = value.args;
    } else break;
  }
  return object(value) ? value : {};
}
