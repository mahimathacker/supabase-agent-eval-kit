import { queryAdmin } from "./db.js";

export interface PolicyInfo {
  table: string;
  policy: string;
  command: string; // SELECT / INSERT / ALL / ...
  roles: string[];
  using: string | null; // the USING (...) expression
  with_check: string | null; // the WITH CHECK (...) expression
}

/**
 * Read the RLS policies on public-schema tables, optionally for one table.
 * pg_policies exposes the parsed USING / WITH CHECK expressions as text, which
 * is exactly what an agent needs to reason about who can see what. Metadata ->
 * admin connection.
 */
export async function getPolicies(table?: string): Promise<PolicyInfo[]> {
  const params: unknown[] = [];
  let where = "where schemaname = 'public'";
  if (table) {
    params.push(table);
    where += ` and tablename = $${params.length}`;
  }

  const { rows } = await queryAdmin(
    `select tablename  as table,
            policyname as policy,
            cmd        as command,
            roles,
            qual       as using,
            with_check
     from pg_policies
     ${where}
     order by tablename, policyname`,
    params,
  );

  return rows.map((r) => ({
    table: String(r.table),
    policy: String(r.policy),
    command: String(r.command),
    // `roles` comes back as a Postgres text[] -> JS array already.
    roles: Array.isArray(r.roles) ? r.roles.map(String) : [],
    using: r.using === null ? null : String(r.using),
    with_check: r.with_check === null ? null : String(r.with_check),
  }));
}
