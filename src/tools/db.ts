import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and paste the value " +
      "printed by `supabase start` (the local Postgres URL).",
  );
}

export const pool = new Pool({ connectionString, max: 4 });

// A query that runs read-only never needs more than a few seconds. This is the
// last line of defense against a runaway query (e.g. an accidental cross join).
const STATEMENT_TIMEOUT_MS = 5_000;

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
}

export type RunFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

function shape(res: pg.QueryResult): QueryResult {
  return {
    rows: res.rows as Record<string, unknown>[],
    rowCount: res.rowCount ?? res.rows.length,
    columns: res.fields?.map((f) => f.name) ?? [],
  };
}

/**
 * Admin/metadata connection: runs as the connection's base role (the Supabase
 * `postgres` role) with NO RLS scoping. Use this ONLY for schema/catalog
 * introspection (list_tables, describe_table, get_rls_policies) and for
 * resolving a user's email -> id. Never use it to read tenant data — it would
 * bypass RLS and defeat the whole point.
 */
export async function queryAdmin(sql: string, params: unknown[] = []): Promise<QueryResult> {
  return shape(await pool.query(sql, params));
}

/** Resolve a profile email to its UUID (used to "act as" a user). */
export async function resolveUserId(email: string): Promise<string | null> {
  const { rows } = await queryAdmin(
    "select id from public.profiles where email = $1",
    [email],
  );
  return rows.length ? String(rows[0].id) : null;
}

/**
 * Run `fn` inside a READ ONLY transaction, scoped to a user's identity.
 *
 * - `actingUserId` provided -> assume the `authenticated` role and put that
 *   user's id in request.jwt.claims, so auth.uid() resolves to them and the
 *   RLS policies apply AS THAT USER.
 * - `actingUserId` null -> run as `anon` (unauthenticated): with our grants,
 *   that role can read nothing. This models a logged-out request.
 *
 * Because the transaction is READ ONLY, any write slips straight into a
 * Postgres error even if the SQL safety check above it had a bug. Defense in
 * depth: parse-time allowlist + DB-enforced read-only + statement timeout.
 *
 * Production hardening note: ideally the pool connects as a dedicated
 * least-privilege login role rather than `postgres`. Here, the read-only
 * transaction and the role switch are the active guarantees.
 */
export async function withReadOnly<T>(
  actingUserId: string | null,
  fn: (run: RunFn) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin transaction read only");
    await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    if (actingUserId) {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: actingUserId, role: "authenticated" }),
      ]);
    } else {
      await client.query("set local role anon");
    }
    const run: RunFn = async (sql, params = []) => shape(await client.query(sql, params));
    return await fn(run);
  } finally {
    // Read-only txn: rollback always (also discards the SET LOCALs).
    try {
      await client.query("rollback");
    } catch {
      /* connection may already be aborted; ignore */
    }
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
