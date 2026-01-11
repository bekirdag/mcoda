import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTaskCommentSlug, formatTaskCommentBody } from "../TaskCommentFormatter.js";

describe("TaskCommentFormatter", () => {
  it("creates deterministic slugs with short hashes", () => {
    const input = {
      source: "code-review",
      file: "src/app.ts",
      line: 12,
      message: "Fix null guard in handler",
    };
    const slugA = createTaskCommentSlug(input);
    const slugB = createTaskCommentSlug({ ...input });
    const slugC = createTaskCommentSlug({ ...input, message: "Different message" });

    assert.equal(slugA, slugB);
    assert.notEqual(slugA, slugC);
    assert.match(slugA, /^code-review-[a-z0-9-]+-[a-f0-9]{8}$/);
  });

  it("formats comment bodies with slug, location, and suggested fix", () => {
    const slug = createTaskCommentSlug({
      source: "qa-tasks",
      file: "src/components/Button.tsx",
      line: 48,
      message: "Button lacks aria-label",
    });
    const body = formatTaskCommentBody({
      slug,
      source: "qa-tasks",
      category: "accessibility",
      status: "open",
      file: "src/components/Button.tsx",
      line: 48,
      message: "Button lacks aria-label",
      suggestedFix: "Add aria-label when icon-only",
    });

    assert.match(body, /\[task-comment\]/);
    assert.match(body, new RegExp(`slug: ${slug}`));
    assert.match(body, /source: qa-tasks/);
    assert.match(body, /category: accessibility/);
    assert.match(body, /status: open/);
    assert.match(body, /location: src\/components\/Button\.tsx:48/);
    assert.match(body, /message:\nButton lacks aria-label/);
    assert.match(body, /suggested_fix:\nAdd aria-label when icon-only/);
  });
});
