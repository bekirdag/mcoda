import assert from "node:assert/strict";
import test from "node:test";
import { isVerificationCommand } from "../VerificationCommand.js";

test("common presentation flags and direct Node test files retain validation eligibility", () => {
  for (const [command, args] of [
    ["npm", ["--silent", "test"]], ["npm", ["-s", "run", "typecheck"]],
    ["pnpm", ["--quiet", "run", "test:unit"]], ["yarn", ["--no-progress", "test"]], ["bun", ["test"]],
    ["node", ["--test", "test/task.test.mjs"]], ["node", ["test/task.test.mjs"]],
    ["node", ["--no-warnings", "test/task.spec.cjs"]], ["tsc", ["--noEmit"]],
    ["pytest", ["-v", "tests"]], ["python3", ["-m", "unittest"]], ["cargo", ["test"]],
  ] as Array<[string, string[]]>) assert.equal(isVerificationCommand({ command, args }), true, `${command} ${args.join(" ")}`);
});

test("help, skipped checks, unknown wrappers and script arguments cannot claim validation", () => {
  for (const [command, args] of [
    ["npm", ["--unknown", "test"]], ["npm", ["run", "echo"]], ["npm", ["--dry-run", "test"]],
    ["npm", ["run", "test", "--if-present"]], ["node", ["script.js", "--test"]],
    ["node", ["-e", "console.log('ok')", "--test"]], ["echo", ["npm", "test"]],
    ["tsc", ["--version"]], ["tsc", ["-v"]], ["tsc", ["--showConfig"]],
    ["pytest", ["--collect-only"]], ["pytest", ["-V"]], ["python3", ["-m", "pytest", "--help"]],
  ] as Array<[string, string[]]>) assert.equal(isVerificationCommand({ command, args }), false, `${command} ${args.join(" ")}`);
  for (const args of [null, [], { command: "npm", args: [1, "test"] }, { command: "npm", args: "test" }]) assert.equal(isVerificationCommand(args), false);
});
