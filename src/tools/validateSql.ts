import { parse } from "pgsql-ast-parser";

/**
 * Result of analyzing a SQL string for read-only safety.
 *  - safe:           may it run?
 *  - statementType:  what the parser saw ('select', 'insert', 'multiple', ...)
 *  - reason:         human-readable explanation when unsafe
 */
export interface SafetyResult {
  safe: boolean;
  statementType: string;
  reason?: string;
}

// Why parse instead of keyword-scan? A blocklist of words like "DELETE" is
// fragile: it false-positives on identifiers/strings ("SELECT 'delete me'")
// and false-negatives on things like a write-CTE (WITH x AS (INSERT ...)),
// COPY, MERGE, DO $$, or two statements separated by ';'. Parsing the SQL and
// allowing ONLY read-only shapes is both stricter and more accurate.
type AstNode = { type?: string; [k: string]: unknown };

function checkReadOnly(node: AstNode | undefined): { ok: boolean; offending?: string } {
  const t = node?.type;
  switch (t) {
    case "select":
    case "values":
      return { ok: true };
    case "union":
    case "union all":
      return (
        firstFailure(checkReadOnly(node!.left as AstNode), () =>
          checkReadOnly(node!.right as AstNode),
        )
      );
    case "with":
    case "with recursive": {
      for (const b of (node!.bind as { statement: AstNode }[]) ?? []) {
        const r = checkReadOnly(b.statement);
        if (!r.ok) return r;
      }
      return checkReadOnly(node!.in as AstNode);
    }
    default:
      // insert / update / delete / drop / alter / truncate / create /
      // grant / revoke / copy / merge / ... anything not explicitly read-only.
      return { ok: false, offending: t ?? "unknown" };
  }
}

function firstFailure(
  left: { ok: boolean; offending?: string },
  right: () => { ok: boolean; offending?: string },
): { ok: boolean; offending?: string } {
  return left.ok ? right() : left;
}

export function analyzeSql(sql: string): SafetyResult {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { safe: false, statementType: "empty", reason: "Empty SQL." };
  }

  let statements;
  try {
    statements = parse(trimmed) as AstNode[];
  } catch (e) {
    return {
      safe: false,
      statementType: "parse_error",
      reason: `Could not parse SQL: ${(e as Error).message}`,
    };
  }

  if (statements.length === 0) {
    return { safe: false, statementType: "empty", reason: "No statement found." };
  }
  if (statements.length > 1) {
    return {
      safe: false,
      statementType: "multiple",
      reason: `Only a single statement is allowed; found ${statements.length}.`,
    };
  }

  const stmt = statements[0];
  const result = checkReadOnly(stmt);
  if (result.ok) {
    return { safe: true, statementType: stmt.type ?? "select" };
  }

  const op = (result.offending ?? "unknown").toUpperCase();
  return {
    safe: false,
    statementType: result.offending ?? "unknown",
    reason: `${op} is not allowed — only read-only SELECT queries are permitted.`,
  };
}
