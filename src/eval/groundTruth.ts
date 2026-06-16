import { resolveUserId, withReadOnly } from "../tools/db.js";

/**
 * Compute the canonical result for a task by running its ground-truth SQL
 * ourselves — crucially, AS THE SAME ACTING USER, inside the same read-only,
 * RLS-scoped transaction the agent's tool uses. So "correct" means "what this
 * user is actually allowed to see", not "every row in the table". This is the
 * source of truth the judge grades the agent's answer against.
 */
export interface GroundTruth {
  ok: boolean;
  rowCount: number;
  rows: Record<string, unknown>[];
  error?: string;
}

export async function getGroundTruth(
  sql: string,
  actingUser: string | null,
): Promise<GroundTruth> {
  try {
    const userId = actingUser ? await resolveUserId(actingUser) : null;
    const res = await withReadOnly(userId, (run) => run(sql));
    return { ok: true, rowCount: res.rowCount, rows: res.rows };
  } catch (e) {
    return { ok: false, rowCount: 0, rows: [], error: (e as Error).message };
  }
}
