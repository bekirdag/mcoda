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
