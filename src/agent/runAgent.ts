import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { AgentResult, AgentUsage, RunAgentOptions, ToolCall } from "./types.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_ITERATIONS = 12;

// Opus 4.8 pricing, USD per 1M tokens. Cache read ~0.1x input; write ~1.25x.
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const;

const SYSTEM = `You are a careful data assistant working against a Supabase (Postgres) project through a small set of tools.

You are acting as ONE specific authenticated user, and Row-Level Security is enforced on every query. You can only see data that user is permitted to see — so when a task says "all", it means all rows visible to you, not every row in the database.

How to work:
- Discover before you query. Use list_tables and describe_table to learn real table/column names and allowed values instead of guessing. CHECK constraints in describe_table reveal enum-like values.
- The only way to read data is run_readonly_sql, which takes a single read-only SELECT. Writes and DDL are refused by design — do not attempt them.
- If a query returns no rows or fewer than expected, suspect RLS first. get_rls_policies and explain_query_result help you see what is being filtered and why.
- Prefer one well-formed SELECT over many round-trips. Use validate_sql_safety only when you are unsure a statement is a safe SELECT.

Answer concisely and ground every claim in tool results: name the tables/columns you used. If RLS prevented access, say so plainly rather than guessing at hidden data.`;

/** Locate src/tools/server.ts relative to this file (works from any cwd). */
function serverEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../tools/server.ts");
}

/** Pull the text payload out of an MCP tool result's content array. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Did our own safety layer refuse this call? (vs. an RLS/permission outcome) */
function isBlocked(output: unknown): boolean {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    return o.blocked === true || o.safe === false;
  }
  return false;
}

/**
 * Run the agent on one task. Spawns the real MCP server as a child process with
 * the given acting user (so RLS is scoped to them), then drives Claude through a
 * manual tool-use loop, recording every tool call for scoring.
 */
export async function runAgent(task: string, opts: RunAgentOptions): Promise<AgentResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const startedAt = Date.now();

  // Spawn the MCP server DIRECTLY via tsx — never `npm run`, whose banner would
  // corrupt the stdio protocol channel. The acting user is passed by env, so
  // the model can never change whose data it reads.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (opts.actingUser) env.ACTING_USER = opts.actingUser;
  else delete env.ACTING_USER;

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverEntry()],
    env,
  });
  const mcp = new Client({ name: "supabase-eval-agent", version: "0.1.0" });
  await mcp.connect(transport);

  const anthropic = new Anthropic();
  const toolCalls: ToolCall[] = [];
  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  try {
    // Convert MCP tool definitions into Anthropic tool definitions.
    const { tools: mcpTools } = await mcp.listTools();
    const tools = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema:
        t.inputSchema && (t.inputSchema as { type?: string }).type
          ? (t.inputSchema as Anthropic.Tool.InputSchema)
          : ({ type: "object", properties: {} } as Anthropic.Tool.InputSchema),
    }));

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
    let answer = "";
    let stopReason = "max_iterations";
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;
      const response = await anthropic.messages.create({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        tools,
        messages,
      });

      usage.inputTokens += response.usage.input_tokens ?? 0;
      usage.outputTokens += response.usage.output_tokens ?? 0;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;

      if (response.stop_reason !== "tool_use") {
        // Final turn: collect the text answer and stop.
        answer = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        stopReason = response.stop_reason ?? "end_turn";
        break;
      }

      // Echo the assistant turn back verbatim (preserves thinking + tool_use
      // blocks, which Opus 4.8 requires for a valid follow-up).
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const use of toolUses) {
        const t0 = Date.now();
        let output: unknown = null;
        let isError = false;
        let resultText = "";
        try {
          const res = await mcp.callTool({
            name: use.name,
            arguments: (use.input ?? {}) as Record<string, unknown>,
          });
          isError = res.isError === true;
          resultText = textOf(res.content);
          try {
            output = JSON.parse(resultText);
          } catch {
            output = resultText;
          }
        } catch (err) {
          isError = true;
          resultText = `Tool error: ${(err as Error).message}`;
          output = { error: resultText };
        }

        toolCalls.push({
          name: use.name,
          input: use.input,
          output,
          isError,
          blocked: isBlocked(output),
          latencyMs: Date.now() - t0,
        });

        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: resultText,
          is_error: isError,
        });
      }

      messages.push({ role: "user", content: results });
    }

    const costUsd =
      (usage.inputTokens * PRICE.input +
        usage.outputTokens * PRICE.output +
        usage.cacheReadTokens * PRICE.cacheRead +
        usage.cacheCreationTokens * PRICE.cacheWrite) /
      1_000_000;

    return {
      answer,
      toolCalls,
      usage,
      costUsd,
      latencyMs: Date.now() - startedAt,
      iterations,
      stopReason,
    };
  } finally {
    await mcp.close();
  }
}
