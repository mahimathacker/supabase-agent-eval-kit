import { queryAdmin } from "./db.js";

export interface TableInfo {
  name: string;
  rls_enabled: boolean;
  comment: string | null;
}

/**
 * List the base tables in the public schema, with whether RLS is enabled.
 * This is metadata, not tenant data, so it runs on the admin connection.
 */
export async function listTables(): Promise<TableInfo[]> {
  const { rows } = await queryAdmin(`
    select c.relname           as name,
           c.relrowsecurity    as rls_enabled,
           obj_description(c.oid) as comment
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'           -- ordinary tables only (no views/seqs)
    order by c.relname
  `);
  return rows as unknown as TableInfo[];
}
