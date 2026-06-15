import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { resolveUserId } from "./db.js";
import { listTables } from "./listTables.js";
import { describeTable } from "./describeTable.js";
import { getPolicies } from "./getPolicies.js";
import { analyzeSql } from "./validateSql.js";
import { runReadonlySql } from "./runReadonlySql.js";
import { explainQuery } from "./explainQueryResult.js";

// IMPORTANT: stdout is the MCP transport channel. Anything we print to stdout
// would corrupt the protocol, so ALL logging goes to stderr.
const log = (...args: unknown[]) => console.error("[mcp]", ...args);

// MCP tool results are { content: [...] }. We return JSON text the agent reads.
function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

async function main() {
  // The acting user is decided by WHOEVER SPAWNS this server (the eval harness),
  // via the ACTING_USER env var. The agent cannot change it.
  const actingEmail = process.env.ACTING_USER ?? null;
  let actingUserId: string | null = null;

  if (actingEmail) {
    actingUserId = await resolveUserId(actingEmail);
    if (actingUserId) log(`acting as ${actingEmail} (${actingUserId})`);
    else log(`WARNING: ACTING_USER "${actingEmail}" not found — data queries run as anon`);
  } else {
    log("no ACTING_USER set — data queries run as anon (RLS reveals nothing)");
  }

  const server = new McpServer({ name: "supabase-eval-tools", version: "0.1.0" });

  server.registerTool(
    "list_tables",
    {
      description:
        "List the base tables in the public schema and whether RLS is enabled on each. " +
        "Call this first to discover the schema before writing any SQL.",
      inputSchema: {},
    },
    async () => json(await listTables()),
  );

  server.registerTool(
    "describe_table",
    {
      description:
        "Describe one table: columns and types, primary key, foreign keys, CHECK " +
        "constraints (which reveal allowed enum-like values), and whether RLS is on. " +
        "Call this to learn a table's shape before querying it.",
      inputSchema: { table: z.string().describe("Table name in the public schema") },
    },
    async ({ table }) => json(await describeTable(table)),
  );

  server.registerTool(
    "get_rls_policies",
    {
      description:
        "Return the Row-Level Security policies (USING / WITH CHECK expressions, " +
        "commands, roles) for the public schema, optionally filtered to one table. " +
        "Use this to reason about who can see which rows and why.",
      inputSchema: {
        table: z.string().optional().describe("Optional: restrict to a single table"),
      },
    },
    async ({ table }) => json(await getPolicies(table)),
  );

  server.registerTool(
    "validate_sql_safety",
    {
      description:
        "Check whether a SQL string is a single read-only SELECT (the only thing " +
        "allowed to run). Returns whether it is safe and, if not, the offending " +
        "statement type. Use this before run_readonly_sql when unsure.",
      inputSchema: { sql: z.string().describe("The SQL to check") },
    },
    async ({ sql }) => json(analyzeSql(sql)),
  );

  server.registerTool(
    "run_readonly_sql",
    {
      description:
        "Run a single read-only SELECT against the database AS the current user " +
        "(so RLS applies) and return the rows. Writes/DDL are refused. This is the " +
        "only way to read actual data.",
      inputSchema: { sql: z.string().describe("A single read-only SELECT statement") },
    },
    async ({ sql }) => json(await runReadonlySql(sql, actingUserId)),
  );

  server.registerTool(
    "explain_query_result",
    {
      description:
        "Run EXPLAIN ANALYZE for a read-only SELECT as the current user and return " +
        "the plan plus the ACTUAL row count produced. Use this to debug why a query " +
        "returns no/unexpected rows (e.g. RLS filtering everything out).",
      inputSchema: { sql: z.string().describe("A single read-only SELECT statement") },
    },
    async ({ sql }) => json(await explainQuery(sql, actingUserId)),
  );

  await server.connect(new StdioServerTransport());
  log("server ready on stdio");
}

main().catch((e) => {
  console.error("[mcp] fatal:", e);
  process.exit(1);
});
