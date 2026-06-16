// Shapes the agent loop produces. Layer 3 (scoring) consumes AgentResult — it
// is the full, observable record of one agent run against one task.

/** One tool invocation the agent made, with everything we measure about it. */
export interface ToolCall {
  name: string;
  input: unknown;
  /** Parsed JSON the tool returned (our tools always return a JSON object). */
  output: unknown;
  /** MCP-level failure (transport / unexpected throw inside the tool). */
  isError: boolean;
  /** Our safety layer refused this (unsafe SQL, or a non-SELECT). Derived from
   *  the tool's own payload (run_readonly_sql.blocked / validate_sql_safety.safe). */
  blocked: boolean;
  latencyMs: number;
}

/** Token usage summed across every model call in the run. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** The complete result of running the agent on one task. */
export interface AgentResult {
  /** The agent's final natural-language answer. */
  answer: string;
  /** Ordered trace of every tool call (the heart of behavioral scoring). */
  toolCalls: ToolCall[];
  usage: AgentUsage;
  /** Estimated USD cost from usage at Opus 4.8 rates. */
  costUsd: number;
  /** Wall-clock time for the whole run. */
  latencyMs: number;
  /** Number of model round-trips (a proxy for how much "thinking in the loop"). */
  iterations: number;
  /** Why the loop ended: the model's last stop_reason, or "max_iterations". */
  stopReason: string;
}

export interface RunAgentOptions {
  /** Email of the profile to act as (sets RLS identity). null = logged-out. */
  actingUser: string | null;
  /** Safety cap on model round-trips so a confused agent can't loop forever. */
  maxIterations?: number;
  /** Override the model (defaults to Opus 4.8). */
  model?: string;
}
