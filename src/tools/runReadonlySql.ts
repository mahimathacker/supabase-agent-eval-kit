import { withReadOnly } from "./db.js";
import { analyzeSql } from "./validateSql.js";

// Cap how many rows we hand back to the model — large result sets waste tokens
// and the agent rarely needs every row to answer.
const MAX_ROWS = 200;

export interface RunResult {
  ok: boolean;
  /** True when the safety gate refused to run the SQL at all. */
  blocked: boolean;
  statementType: string;
  /** Present when blocked or when the DB raised an error. */
  reason?: string;
  rowCount?: number;
  columns?: string[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
}

/**
 * The agent's one window onto actual data. Flow:
 *   1. Safety gate (parse-time allowlist). If it isn't a single read-only
 *      SELECT, we refuse and report why — the agent never reaches the DB.
 *   2. Run inside a READ ONLY transaction, AS the harness-chosen user, so RLS
 *      decides what rows come back.
 *
 * `actingUserId` is fixed by the server process (from ACTING_USER), not chosen
 * by the agent — it cannot escalate its own privileges.
 */
export async function runReadonlySql(
  sql: string,
  actingUserId: string | null,
): Promise<RunResult> {
  const safety = analyzeSql(sql);
  if (!safety.safe) {
    return {
      ok: false,
      blocked: true,
      statementType: safety.statementType,
      reason: safety.reason,
    };
  }

  try {
    const result = await withReadOnly(actingUserId, (run) => run(sql));
    const truncated = result.rows.length > MAX_ROWS;
    return {
      ok: true,
      blocked: false,
      statementType: safety.statementType,
      rowCount: result.rowCount,
      columns: result.columns,
      rows: truncated ? result.rows.slice(0, MAX_ROWS) : result.rows,
      truncated,
    };
  } catch (e) {
    // A DB-level error (e.g. unknown column, or a write that slipped past the
    // parser and hit the read-only transaction) lands here, not as a crash.
    return {
      ok: false,
      blocked: false,
      statementType: safety.statementType,
      reason: (e as Error).message,
    };
  }
}
