import test from "node:test";
import assert from "node:assert/strict";
import { registerSecretValue, redactSecretValues, StreamingSecretRedactor } from "../SecretRedaction.js";

test("streaming redaction protects every bearer split position without losing normal text", () => {
  const input = "Hello Bearer abcdefghijklmnop1234567890 World";
  for (let split = 0; split <= input.length; split++) {
    const stream = new StreamingSecretRedactor();
    assert.equal(stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.finish(), "Hello [redacted] World", `split ${split}`);
  }
  const bytewise = new StreamingSecretRedactor();
  assert.equal([...input].map(c => bytewise.write(c)).join("") + bytewise.finish(), "Hello [redacted] World");
});

test("registered credentials with punctuation are removed across every split", () => {
  const secret = "fixture-pass#word!12:3456"; registerSecretValue(secret);
  const input = `Before ${secret} after.`;
  for (let split = 0; split <= input.length; split++) {
    const stream = new StreamingSecretRedactor();
    assert.equal(stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.finish(), "Before [redacted] after.", `split ${split}`);
  }
  assert.equal(redactSecretValues(JSON.stringify({ response: secret })), '{"response":"[redacted]"}');
  const interrupted = new StreamingSecretRedactor();
  assert.equal(interrupted.write(secret.slice(0, 9)) + interrupted.finish(), "[redacted]");
});

test("oversized streamed tokens never release a prefix or remaining suffix", () => {
  const stream = new StreamingSecretRedactor();
  assert.equal(stream.write(`sk-${"a".repeat(70_000)}`), "[redacted oversized token]");
  assert.equal(stream.write("continuedsecret"), "");
  assert.equal(stream.write(" safe.") + stream.finish(), " safe.");
});
