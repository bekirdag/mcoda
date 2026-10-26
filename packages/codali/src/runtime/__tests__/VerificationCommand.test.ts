import assert from "node:assert/strict";
import test from "node:test";
import { isVerificationCommand, isVerificationInspectionCommand } from "../VerificationCommand.js";

test("common presentation flags and direct Node test files retain validation eligibility", () => {
  for (const [command, args] of [
    ["npm", ["--silent", "test"]], ["npm", ["-s", "run", "typecheck"]],
    ["npm", ["--prefix", "modules/parser", "test"]], ["npm", ["--prefix=modules/parser", "-s", "run", "typecheck"]],
    ["pnpm", ["-C", "modules/parser", "test"]], ["pnpm", ["--dir=modules/parser", "run", "test:unit"]],
    ["yarn", ["--cwd", "modules/parser", "test"]], ["bun", ["--cwd=modules/parser", "test"]],
    ["pnpm", ["--quiet", "run", "test:unit"]], ["yarn", ["--no-progress", "test"]], ["bun", ["test"]],
    ["node", ["--test", "test/task.test.mjs"]], ["node", ["test/task.test.mjs"]],
    ["node", ["--no-warnings", "test/task.spec.cjs"]], ["tsc", ["--noEmit"]],
    ["pytest", ["-v", "tests"]], ["python3", ["-m", "unittest"]], ["cargo", ["test"]],
  ] as Array<[string, string[]]>) assert.equal(isVerificationCommand({ command, args }), true, `${command} ${args.join(" ")}`);
});

test("help, skipped checks, unknown wrappers and script arguments cannot claim validation", () => {
  for (const [command, args] of [
    ["npm", ["--unknown", "test"]], ["npm", ["run", "echo"]], ["npm", ["--dry-run", "test"]],
    ["npm", ["--prefix", "test"]], ["npm", ["--prefix", "--silent", "test"]], ["npm", ["--prefix=", "test"]],
    ["npm", ["--prefix", "modules/parser", "run", "echo"]], ["pnpm", ["--filter", "missing", "test"]],
    ["yarn", ["--cwd", "modules/parser", "--help", "test"]],
    ["npm", ["run", "test", "--if-present"]], ["node", ["script.js", "--test"]],
    ["node", ["-e", "console.log('ok')", "--test"]], ["echo", ["npm", "test"]],
    ["tsc", ["--version"]], ["tsc", ["-v"]], ["tsc", ["--showConfig"]],
    ["pytest", ["--collect-only"]], ["pytest", ["-V"]], ["python3", ["-m", "pytest", "--help"]],
  ] as Array<[string, string[]]>) assert.equal(isVerificationCommand({ command, args }), false, `${command} ${args.join(" ")}`);
  for (const args of [null, [], { command: "npm", args: [1, "test"] }, { command: "npm", args: "test" }]) assert.equal(isVerificationCommand(args), false);
});

test("final validation permits bounded Git inspection without accepting it as test evidence", () => {
  for (const args of [
    ["diff"], ["diff", "--", "USER_NOTES.txt"], ["diff", "--stat", "--cached"],
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", "src/task.mjs"],
    ["diff", "--check"], ["status"], ["status", "--short", "--branch"],
    ["status", "--porcelain=v1", "--", "-leading-dash.txt"],
  ]) {
    assert.equal(isVerificationInspectionCommand({ command: "git", args }), true, args.join(" "));
    assert.equal(isVerificationInspectionCommand({ command: "git", args, writePaths: [] }), true);
    assert.equal(isVerificationCommand({ command: "git", args }), false, "inspection is not a test");
  }
  for (const args of [
    ["add", "src/task.mjs"], ["diff", "--output=report.txt"], ["diff", "--output", "report.txt"],
    ["diff", "--ext-diff"], ["diff", "--textconv"], ["diff", "HEAD"], ["diff", "--", ""],
    ["-c", "alias.inspect=diff", "inspect"], ["-C", "elsewhere", "diff"],
    ["status", "--unknown"], ["diff", 42], [],
  ]) assert.equal(isVerificationInspectionCommand({ command: "git", args }), false, JSON.stringify(args));
  for (const value of [null, [], { command: "git", args: "diff" }, { command: "/tmp/git", args: ["diff"] },
    ...[null, "", ["."], 0].map(writePaths => ({ command: "git", args: ["diff"], writePaths }))]) {
    assert.equal(isVerificationInspectionCommand(value), false);
  }
});
