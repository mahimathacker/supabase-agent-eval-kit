import { queryAdmin } from "./db.js";

export interface ColumnInfo {
  column: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

export interface ForeignKey {
  column: string;
  references_table: string;
  references_column: string;
}

export interface TableDescription {
  table: string;
  exists: boolean;
  rls_enabled: boolean;
  columns: ColumnInfo[];
  primary_key: string[];
  foreign_keys: ForeignKey[];
  // CHECK clauses are valuable for the agent: they reveal allowed enum-like
  // values (e.g. status IN ('active','trial','churned')).
  checks: string[];
}

/**
 * Describe one public-schema table: columns, PK, FKs, CHECK constraints, and
 * whether RLS is on. Metadata only -> admin connection. Table name is passed
 * as a bound parameter, so this is injection-safe even though it's a string.
 */
export async function describeTable(table: string): Promise<TableDescription> {
  const meta = await queryAdmin(
    `select c.relrowsecurity as rls_enabled
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = $1 and c.relkind = 'r'`,
    [table],
  );

  if (meta.rows.length === 0) {
    return {
      table,
      exists: false,
      rls_enabled: false,
      columns: [],
      primary_key: [],
      foreign_keys: [],
      checks: [],
    };
  }

  const cols = await queryAdmin(
    `select column_name, data_type, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = $1
     order by ordinal_position`,
    [table],
  );

  const pk = await queryAdmin(
    `select kcu.column_name
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on kcu.constraint_name = tc.constraint_name
      and kcu.table_schema = tc.table_schema
     where tc.table_schema = 'public' and tc.table_name = $1
       and tc.constraint_type = 'PRIMARY KEY'
     order by kcu.ordinal_position`,
    [table],
  );

  const fks = await queryAdmin(
    `select kcu.column_name              as column,
            ccu.table_name               as references_table,
            ccu.column_name              as references_column
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
     join information_schema.constraint_column_usage ccu
       on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
     where tc.table_schema = 'public' and tc.table_name = $1
       and tc.constraint_type = 'FOREIGN KEY'`,
    [table],
  );

  const checks = await queryAdmin(
    `select cc.check_clause
     from information_schema.table_constraints tc
     join information_schema.check_constraints cc
       on cc.constraint_name = tc.constraint_name
      and cc.constraint_schema = tc.table_schema
     where tc.table_schema = 'public' and tc.table_name = $1
       and tc.constraint_type = 'CHECK'`,
    [table],
  );

  return {
    table,
    exists: true,
    rls_enabled: Boolean(meta.rows[0].rls_enabled),
    columns: cols.rows.map((r) => ({
      column: String(r.column_name),
      type: String(r.data_type),
      nullable: r.is_nullable === "YES",
      default: r.column_default === null ? null : String(r.column_default),
    })),
    primary_key: pk.rows.map((r) => String(r.column_name)),
    foreign_keys: fks.rows as unknown as ForeignKey[],
    checks: checks.rows.map((r) => String(r.check_clause)),
  };
}
