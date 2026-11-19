import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkWrittenJavaScript } from "../WriteSyntaxCheck.js";
import { executorStatus } from "../../tools/shell/IsolatedExecutor.js";

test("write syntax feedback catches invalid modules without executing valid source", async t => {
  const status = executorStatus();
  if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"codali-write-syntax-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const valid = "import fs from 'node:fs'; fs.writeFileSync('should-not-exist','unsafe'); export const value = 1;";
  await fs.writeFile(path.join(root,"valid.mjs"),valid);
  const passed = await checkWrittenJavaScript(root,"valid.mjs",status);
  assert.equal(passed?.status,"passed"); assert.match(passed!.fileHash!,/^[a-f0-9]{64}$/);
  await assert.rejects(fs.stat(path.join(root,"should-not-exist")),{code:"ENOENT"});
  const invalid = "function nested() { export function invalid() {} }";
  await fs.writeFile(path.join(root,"invalid.mjs"),invalid);
  const failed = await checkWrittenJavaScript(root,"invalid.mjs",status);
  assert.equal(failed?.status,"failed"); assert.match(failed!.output,/SyntaxError/);
  assert.equal(await fs.readFile(path.join(root,"invalid.mjs"),"utf8"),invalid);
  assert.equal(await checkWrittenJavaScript(root,"component.tsx",status),undefined);
  assert.equal((await checkWrittenJavaScript(root,"../outside.js",status))?.status,"unavailable");
});
