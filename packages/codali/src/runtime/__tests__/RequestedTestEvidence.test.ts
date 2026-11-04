import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRequestedTestEvidence, isTestSourcePath, requestsAddedTests } from '../RequestedTestEvidence.js';

test('only direct positive test-addition instructions trigger the extra evidence gate', () => {
  for (const description of ['Add meaningful public tests in test/task.test.mjs.', 'Fix the parser and add regression tests.', 'Requirements: implement the feature, add tests, run them.', 'Write new unit test cases.', 'Extend the integration tests.', '- Add regression tests.', '  2. Write unit tests.']) {
    assert.equal(requestsAddedTests([{ description }]), true, description);
  }
  for (const description of ['Run the existing tests.', 'Do not add tests.', 'Never write new tests.', "Don't add tests.", 'Explain how to add tests.', 'Add UI controls to run tests.', 'Update documentation about how to write tests.', 'No new tests are required.']) {
    assert.equal(requestsAddedTests([{ description }]), false, description);
  }
});

test('test evidence must be a changed surviving test source, not a fixture, deletion or quoted output', () => {
  const requirements = [{ description: 'Implement the feature and add meaningful regression tests.' }];
  for (const file of ['test/task.test.mjs', 'src/value.spec.ts', 'tests/value.rs', 'test_value.py', 'value_test.go', 'ValueTest.java']) assert.equal(isTestSourcePath(file), true, file);
  for (const file of ['src/testHelper.ts', 'tests/fixture.json', 'README.md']) assert.equal(isTestSourcePath(file), false, file);
  assert.throws(() => assertRequestedTestEvidence(requirements, ['src/task.mjs'], { 'src/task.mjs': 'new', 'test/task.test.mjs': 'old' }, true), /no test source has changed/);
  assert.throws(() => assertRequestedTestEvidence(requirements, ['test/task.test.mjs'], { 'test/task.test.mjs': 'missing' }, true), /no test source has changed/);
  assert.throws(() => assertRequestedTestEvidence(requirements, ['test/task.test.mjs'], { 'test/task.test.mjs': 'symlink:../outside.mjs' }, true), /no test source has changed/);
  assert.doesNotThrow(() => assertRequestedTestEvidence(requirements, ['test/task.test.mjs'], { 'test/task.test.mjs': 'a'.repeat(64) }, true));
  assert.doesNotThrow(() => assertRequestedTestEvidence(requirements, [], {}, false), 'answer-only work is evaluated by review');
  assert.doesNotThrow(() => assertRequestedTestEvidence([{ description: 'Run the existing tests.' }], ['src/task.mjs'], { 'src/task.mjs': 'new' }, true));
});
