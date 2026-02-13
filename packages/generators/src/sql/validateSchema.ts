export type SqlValidationIssueType = "empty" | "prose" | "syntax" | "unterminated";

export interface SqlValidationIssue {
  line: number;
  message: string;
  type: SqlValidationIssueType;
  excerpt?: string;
}

const STATEMENT_START = /^(create|alter|drop|insert|update|delete|select|with|pragma|begin|commit|rollback|end|vacuum|analyze|attach|detach)\b/i;
const CLAUSE_START = /^(from|where|join|left|right|inner|outer|on|group|order|limit|offset|union|values|set|returning)\b/i;
const CONTINUATION_START =
  /^(,|\)|constraint\b|primary\b|foreign\b|unique\b|check\b|references\b|index\b|key\b|generated\b|as\b|collate\b|not\b|null\b)/i;
const COLUMN_DEF =
  /^(?:`[^`]+`|"[^"]+"|\[[^\]]+]|[A-Za-z_][\w$]*)(?:\s+[A-Za-z_][\w$]*)(?:\s*\([^)]*\))?/i;
const TYPE_KEYWORDS =
  /\b(bigint|int|integer|smallint|tinyint|serial|bigserial|uuid|text|varchar|char|character|boolean|bool|date|timestamp|timestamptz|datetime|time|json|jsonb|blob|real|double|float|numeric|decimal|money|bytea)\b/i;
const CONSTRAINT_KEYWORDS =
  /\b(primary|foreign|references|unique|check|default|collate|generated|identity)\b/i;
const NULL_KEYWORDS = /\bnot\s+null\b|\bnull\b/i;

const stripComments = (line: string, state: { inBlockComment: boolean }): string => {
  let working = line;
  if (state.inBlockComment) {
    const end = working.indexOf("*/");
    if (end === -1) return "";
    working = working.slice(end + 2);
    state.inBlockComment = false;
  }
  let blockStart = working.indexOf("/*");
  while (blockStart !== -1) {
    const blockEnd = working.indexOf("*/", blockStart + 2);
    if (blockEnd === -1) {
      working = working.slice(0, blockStart);
      state.inBlockComment = true;
      break;
    }
    working = `${working.slice(0, blockStart)} ${working.slice(blockEnd + 2)}`;
    blockStart = working.indexOf("/*", blockStart);
  }
  const lineComment = working.indexOf("--");
  if (lineComment !== -1) {
    working = working.slice(0, lineComment);
  }
  return working.trim();
};

const countParens = (line: string): { open: number; close: number } => {
  const stripped = line
    .replace(/'[^']*'/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*]/g, "");
  return {
    open: (stripped.match(/\(/g) ?? []).length,
    close: (stripped.match(/\)/g) ?? []).length,
  };
};

const isSqlLine = (line: string, inStatement: boolean): boolean => {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (STATEMENT_START.test(trimmed)) return true;
  if (!inStatement) return false;
  if (CLAUSE_START.test(trimmed)) return true;
  if (CONTINUATION_START.test(trimmed)) return true;
  if (trimmed === ");" || trimmed === ")" || trimmed === "," || trimmed === ";") return true;
  const normalized = trimmed.replace(/[;,)]\s*$/, "").trim();
  if (COLUMN_DEF.test(normalized)) {
    return TYPE_KEYWORDS.test(normalized) || CONSTRAINT_KEYWORDS.test(normalized) || NULL_KEYWORDS.test(normalized);
  }
  return false;
};

export class ValidateSqlSchema {
  validateContent(raw: string): { errors: SqlValidationIssue[] } {
    const errors: SqlValidationIssue[] = [];
    if (!raw || !raw.trim()) {
      return { errors: [{ line: 1, type: "empty", message: "SQL schema is empty." }] };
    }
    const lines = raw.split(/\r?\n/);
    const state = { inBlockComment: false, inStatement: false, statementStart: 0, parenDepth: 0 };

    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const rawLine = lines[index] ?? "";
      const code = stripComments(rawLine, state);
      if (!code) continue;
      const trimmed = code.trim();

      const isStart = STATEMENT_START.test(trimmed);
      if (!state.inStatement && !isStart) {
        errors.push({
          line: lineNumber,
          type: "prose",
          message: "Non-SQL content detected.",
          excerpt: trimmed.slice(0, 140),
        });
        continue;
      }
      if (state.inStatement && !isSqlLine(trimmed, true)) {
        errors.push({
          line: lineNumber,
          type: "prose",
          message: "Non-SQL content detected inside a statement.",
          excerpt: trimmed.slice(0, 140),
        });
      }

      if (!state.inStatement && isStart) {
        state.inStatement = true;
        state.statementStart = lineNumber;
      }

      const parenCount = countParens(code);
      state.parenDepth += parenCount.open - parenCount.close;
      if (state.parenDepth < 0) {
        errors.push({
          line: lineNumber,
          type: "syntax",
          message: "Unexpected closing parenthesis in SQL statement.",
          excerpt: trimmed.slice(0, 140),
        });
        state.parenDepth = 0;
      }

      if (code.includes(";") && state.parenDepth > 0) {
        errors.push({
          line: lineNumber,
          type: "syntax",
          message: "Statement terminates before closing all parentheses.",
          excerpt: trimmed.slice(0, 140),
        });
      }
      if (code.includes(";") && state.parenDepth <= 0) {
        state.inStatement = false;
        state.statementStart = 0;
        state.parenDepth = 0;
      }
    }

    if (state.inStatement) {
      errors.push({
        line: state.statementStart || lines.length,
        type: "unterminated",
        message: `SQL statement starting at line ${state.statementStart} is missing a terminating semicolon.`,
      });
    }
    if (state.parenDepth > 0) {
      errors.push({
        line: lines.length,
        type: "syntax",
        message: "SQL statement has unbalanced parentheses.",
      });
    }

    return { errors };
  }
}
