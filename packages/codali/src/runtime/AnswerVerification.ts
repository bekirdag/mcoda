import { isTestFile } from "../tools/verification/VitestTool.js";

export interface ExecutedAnswerCode { language: "sql" | "javascript" | "typescript" | "python"; content: string; }

/** Detect presentation drift, not semantic correctness. A passing execution
 * says nothing about code the model subsequently rewrites in its final answer. */
export function unmatchedExecutedCode(text: string, executed: ExecutedAnswerCode[]): string[] {
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();
  const aliases: Record<string, ExecutedAnswerCode["language"]> = { sql: "sql", js: "javascript", mjs: "javascript", javascript: "javascript", ts: "typescript", typescript: "typescript", py: "python", python: "python" };
  const unmatched = new Set<string>();
  for (const match of text.matchAll(/^```(sql|javascript|js|mjs|typescript|ts|python|py)\s*\n([\s\S]*?)^```\s*$/gm)) {
    const language = aliases[match[1]], code = normalize(match[2]);
    const candidates = executed.filter(item => item.language === language);
    if (code && candidates.length && !candidates.some(item => language === "sql" ? normalize(item.content) === code : normalize(item.content).includes(code))) unmatched.add(language);
  }
  return [...unmatched];
}

export interface TestRun { runner?: string; files: Array<{ path: string; content: string }>; }
// The same test-file rule verify_tests applies (test_x.js, x.test.js, ...).
const isTest = (file: { path: string; content: string }, runner?: string) => isTestFile(file, runner === "python" || runner === "node" ? runner : file.path.endsWith(".py") ? "python" : "vitest");
const LANGUAGE_OF = (path: string) => path.endsWith(".py") ? "python" : /\.[cm]?[jt]s$/.test(path) ? "code-js" : undefined;

/** The session's last test run with the final answer's code in place of its
 * source file. Cycle 5 case 28 (.41 regression pack): every verify_tests run
 * failed, the model rewrote the module once more and shipped that version
 * untested; a crash the old tests would have caught reached the user.
 * Undefined unless the mapping is unambiguous: one source file plus test
 * files, and one answer code block in that language that differs from it. */
export function finalCodeRerun(text: string, last: TestRun | undefined): TestRun | undefined {
  if (!last?.files?.length) return;
  const sources = last.files.filter(file => !isTest(file, last.runner));
  if (sources.length !== 1 || sources.length === last.files.length) return;
  const language = LANGUAGE_OF(sources[0].path);
  if (!language) return;
  const blocks = [...text.matchAll(/^```(python|py|javascript|js|mjs|typescript|ts)\s*\n([\s\S]*?)^```\s*$/gm)]
    .filter(match => (["python", "py"].includes(match[1]) ? "python" : "code-js") === language).map(match => match[2]);
  if (blocks.length !== 1 || blocks[0].length > 60000) return;
  const code = blocks[0].replace(/\r\n/g, "\n").trim();
  if (!code || code === sources[0].content.replace(/\r\n/g, "\n").trim()) return;
  return { ...(last.runner ? { runner: last.runner } : {}), files: last.files.map(file => file === sources[0] ? { path: file.path, content: `${code}\n` } : file) };
}

/** Recognize only unambiguous standalone source/test pairs. This suggests a
 * verifier invocation; it never executes quoted code or grants permission. */
export function answerTestBundle(text: string): { runner: "node" | "python"; files: Array<{ path: string; content: string }> } | undefined {
  const blocks = [...text.matchAll(/^```(javascript|js|mjs|python|py)\s*\n([\s\S]*?)^```\s*$/gm)]
    .map(match => ({ language: match[1], content: match[2] }));
  if (blocks.length !== 2 || blocks.some(block => block.content.length > 24000)) return;
  const [source, tests] = blocks;
  if ([source, tests].every(block => ["javascript", "js", "mjs"].includes(block.language))
    && /\bexport\b/.test(source.content) && /["']node:test["']/.test(tests.content)) {
    const imports = [...tests.content.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map(match => match[1]);
    const local = imports.filter(value => !value.startsWith("node:"));
    if (local.length !== 1 || !/^\.\/[A-Za-z0-9_-]+\.(?:mjs|js)$/.test(local[0])) return;
    const name = local[0].slice(2);
    if (name === "answer.test.mjs") return;
    return { runner: "node", files: [{ path: name, content: source.content }, { path: "answer.test.mjs", content: tests.content }] };
  }
  if ([source, tests].every(block => ["python", "py"].includes(block.language))
    && /\bunittest\.TestCase\b/.test(tests.content) && !/^\s*from\s+/m.test(tests.content)
    && [...tests.content.matchAll(/^\s*import\s+([^\n]+)/gm)].every(match => match[1].trim() === "unittest")) {
    return { runner: "python", files: [{ path: "test_answer.py", content: `${source.content}\n${tests.content}` }] };
  }
}
