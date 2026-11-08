import test from "node:test";
import assert from "node:assert/strict";
import { answerTestBundle, unmatchedExecutedCode } from "../AnswerVerification.js";
const fence = (language: string, code: string) => `\`\`\`${language}\n${code}\n\`\`\`\n`;
test("standalone source/tests retain exact source, including bugs for execution to catch", () => {
  const source = "export const add = (a,b) => a + missing;";
  const checks = "import test from 'node:test'; import {add} from './impl.mjs'; test('add',()=>add(1,2));";
  const result = answerTestBundle(fence("js", source) + fence("javascript", checks));
  assert.equal(result?.runner, "node");
  assert.deepEqual(result?.files, [{ path: "impl.mjs", content: source + "\n" }, { path: "answer.test.mjs", content: checks + "\n" }]);
  const python = answerTestBundle(fence("python", "def add(a,b): return a+b") + fence("python", "import unittest\nclass Tests(unittest.TestCase):\n def test_add(self): self.assertEqual(add(1,2),3)"));
  assert.equal(python?.runner, "python");
  assert.equal(python?.files[0].path, "test_answer.py");
});
test("ambiguous, unsafe and unsupported bundles do not trigger verification guidance", () => {
  const source = fence("js", "export const add=()=>1;");
  for (const module of ["../impl.js", "/impl.js", "./nested/impl.js", "some-package", "./answer.test.mjs"]) {
    assert.equal(answerTestBundle(source + fence("js", `import test from 'node:test'; import {add} from '${module}';`)), undefined);
  }
  assert.equal(answerTestBundle(source), undefined);
  assert.equal(answerTestBundle(source + source + fence("js", "import test from 'node:test';")), undefined);
  assert.equal(answerTestBundle(fence("python", "def a(): pass") + fence("python", "import unittest\nfrom impl import a\nclass T(unittest.TestCase): pass")), undefined);
});


test("final code must match executed source rather than an obsolete or rewritten draft", () => {
  const executed = [{ language: "sql" as const, content: "SELECT amount FROM ledger;" }, { language: "python" as const, content: "def value():\n    return 3\n" }];
  assert.deepEqual(unmatchedExecutedCode(fence("sql", "SELECT amount FROM ledger;"), executed), []);
  assert.deepEqual(unmatchedExecutedCode(fence("sql", "SELECT 0 FROM ledger;"), executed), ["sql"]);
  assert.deepEqual(unmatchedExecutedCode(fence("sql", "SELECT missing FROM ledger;") + fence("sql", "SELECT amount FROM ledger;"), executed), ["sql"]);
  assert.deepEqual(unmatchedExecutedCode(fence("python", "def value():\r\n    return 3"), executed), []);
  assert.deepEqual(unmatchedExecutedCode(fence("python", "def value():\n    return 4"), executed), ["python"]);
  assert.deepEqual(unmatchedExecutedCode(fence("js", "const unrelated = 1;"), executed), []);
  assert.deepEqual(unmatchedExecutedCode(fence("sql", "SELECT 0 FROM ledger;"), []), []);
});
