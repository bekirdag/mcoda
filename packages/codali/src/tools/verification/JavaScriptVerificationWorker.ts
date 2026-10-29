// Runs only in the separate OS-isolated verification process. vm separates the
// observation harness from the submitted program; it is NOT the security boundary.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const input = JSON.parse(readFileSync("input.json", "utf8")) as { source: string; entry: string; inputs: unknown[][] };
const observations: unknown[] = [];
for (const args of input.inputs) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  // Capture intrinsics before evaluating submitted code. Serialize data without
  // calling guest toJSON methods or accessors, and reject non-JSON results.
  const observe = vm.runInContext(`(() => {
    const parse = JSON.parse, stringify = JSON.stringify, apply = Reflect.apply, string = String;
    const descriptors = Object.getOwnPropertyDescriptors, prototype = Object.getPrototypeOf;
    const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
    const isArray = Array.isArray, finite = Number.isFinite, keys = Object.keys;
    const hasOwn = Object.hasOwn;
    function encode(value, depth = 0, seen = []) {
      if (depth > 32 || seen.length > 10000) throw 'Result exceeds JSON limits';
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return stringify(value);
      if (typeof value === 'number' && finite(value)) return stringify(value);
      if (typeof value !== 'object') throw 'Expected finite JSON data';
      for (let i = 0; i < seen.length; i++) if (seen[i] === value) throw 'Cyclic result';
      seen[seen.length] = value;
      const array = isArray(value), proto = prototype(value);
      if (proto !== null && proto !== (array ? arrayPrototype : objectPrototype)) throw 'Expected plain JSON data';
      const fields = descriptors(value), names = keys(fields);
      let text = array ? '[' : '{', count = 0;
      const length = array ? fields.length.value : names.length;
      if (length > 10000) throw 'Result exceeds JSON limits';
      for (let i = 0; i < length; i++) {
        const key = array ? string(i) : names[i], field = fields[key];
        if (!field || !hasOwn(field, 'value')) throw 'Sparse arrays and accessors are unsupported';
        if (!array && !field.enumerable) continue;
        if (count++) text += ',';
        if (!array) text += stringify(key) + ':';
        text += encode(field.value, depth + 1, seen);
        if (text.length > 32768) throw 'Result exceeds JSON limits';
      }
      seen.length--;
      return text + (array ? ']' : '}');
    }
    return (fn, encoded) => {
      const args = parse(encoded), before = encode(args);
      const result = apply(fn, undefined, args);
      const actual = encode(result), unchanged = before === encode(args);
      return '{"actual":' + actual + ',"inputPreserved":' + unchanged + '}';
    };
  })()`, context, { timeout: 250 });
  // No buffers/native APIs are needed for this synchronous JSON-only tool.
  vm.runInContext(`
    for (const intrinsic of [Object, Array, Function, String, Number, Boolean, JSON, Reflect]) Object.freeze(intrinsic.prototype ?? intrinsic);
    for (const name of ['console','ArrayBuffer','SharedArrayBuffer','WebAssembly','DataView','Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array']) delete globalThis[name];
  `, context, { timeout: 250 });
  try {
    const module = new vm.SourceTextModule(input.source, { context, identifier: "submission.mjs" });
    // Reject imports without passing a host Error/function into the guest realm.
    await module.link(async () => { throw undefined; });
    await module.evaluate({ timeout: 250 });
    const fn = (module.namespace as Record<string, unknown>)[input.entry];
    if (typeof fn !== "function") throw undefined;
    context.__codaliObserve = observe;
    context.__codaliFunction = fn;
    context.__codaliInput = JSON.stringify(args);
    const encoded: unknown = vm.runInContext("__codaliObserve(__codaliFunction, __codaliInput)", context, { timeout: 250 });
    if (typeof encoded !== "string" || encoded.length > 40000) throw undefined;
    observations.push(JSON.parse(encoded));
  } catch {
    // Never inspect/stringify a guest exception: its getters may execute code.
    observations.push({ error: "Program failed, timed out, imported a module, or returned unsupported non-JSON data" });
  }
}
process.stdout.write(JSON.stringify({ observations }));
