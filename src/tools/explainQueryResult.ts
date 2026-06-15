import { withReadOnly } from "./db.js";
import { analyzeSql } from "./validateSql.js";

export interface ExplainResult {
  ok: boolean;
  blocked: boolean;
  reason?: string;
  /** Actual rows the query produced for the acting user (0 is the key signal
   *  when debugging "why does this return nothing?"). */
  actual_rows?: number;
  plan?: string[];
}

/**
 * Diagnostic tool for "why does my query return no/odd rows?".
 *
 * Runs `EXPLAIN (ANALYZE, FORMAT TEXT)` for the acting user. ANALYZE actually
 * executes the SELECT (safe: read-only txn + statement timeout), so the plan
 * reports the *actual* row counts the user can see. If RLS filtered everything
 * out, the agent sees `actual_rows = 0` and a plan whose scan is gated by the
 * policy — concrete evidence, not a guess.
 */
export async function explainQuery(
  sql: string,
  actingUserId: string | null,
): Promise<ExplainResult> {
  const safety = analyzeSql(sql);
  if (!safety.safe) {
    return { ok: false, blocked: true, reason: safety.reason };
  }

  try {
    const result = await withReadOnly(actingUserId, (run) =>
      run(`explain (analyze, format text) ${sql}`),
    );
    // Each row of EXPLAIN output is a single text column ("QUERY PLAN").
    const plan = result.rows.map((r) => String(Object.values(r)[0]));
    const actualRowsLine = plan.find((l) => /actual time=.*rows=\d+/.test(l));
    const match = actualRowsLine?.match(/rows=(\d+)/);
    return {
      ok: true,
      blocked: false,
      actual_rows: match ? Number(match[1]) : undefined,
      plan,
    };
  } catch (e) {
    return { ok: false, blocked: false, reason: (e as Error).message };
  }
}
