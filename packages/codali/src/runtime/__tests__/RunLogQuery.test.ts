import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUN_LOG_QUERY_LIMIT,
  MAX_RUN_LOG_QUERY_LIMIT,
  normalizeRunLogQueryInput,
} from "../RunLogQuery.js";

test("normalizeRunLogQueryInput applies defaults", { concurrency: false }, () => {
  const query = normalizeRunLogQueryInput();
  assert.equal(query.limit, DEFAULT_RUN_LOG_QUERY_LIMIT);
  assert.equal(query.offset, 0);
  assert.equal(query.sort, "asc");
  assert.deepEqual(query.filters, {
    run_id: undefined,
    task_id: undefined,
    phase: undefined,
    event_type: undefined,
    failure_class: undefined,
  });
});

test("normalizeRunLogQueryInput trims filters and clamps bounds", { concurrency: false }, () => {
  const query = normalizeRunLogQueryInput({
    filters: {
      run_id: " run-1 ",
      task_id: " task-9 ",
      phase: " verify ",
      event_type: " run_summary ",
      failure_class: " verification_failure ",
    },
    limit: MAX_RUN_LOG_QUERY_LIMIT + 500,
    offset: -10,
    sort: "desc",
  });
  assert.equal(query.limit, MAX_RUN_LOG_QUERY_LIMIT);
  assert.equal(query.offset, 0);
  assert.equal(query.sort, "desc");
  assert.equal(query.filters.run_id, "run-1");
  assert.equal(query.filters.task_id, "task-9");
  assert.equal(query.filters.phase, "verify");
  assert.equal(query.filters.event_type, "run_summary");
  assert.equal(query.filters.failure_class, "verification_failure");
});
