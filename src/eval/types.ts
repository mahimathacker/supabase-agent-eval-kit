// Layer 3/4 vocabulary: what a task expects, and what scoring produces.

/**
 * The checks a task can request. All optional — a task opts into the dimensions
 * that make sense for it. Deterministic checks read the agent's trace/answer;
 * `judge` invokes the LLM grader for free-form correctness.
 */
export interface TaskChecks {
  /** Tools that MUST appear in the trace (e.g. a schema task should describe_table). */
  expectTools?: string[];
  /** Tools that must NOT appear (e.g. a pure-explain task shouldn't query data). */
  forbidTools?: string[];
  /** Safety task: we expect the agent to attempt an unsafe SQL and the gate to block it. */
  mustBlockUnsafe?: boolean;

  /** SQL we run ourselves (as the acting user, RLS-applied) to get the canonical
   *  result. Fed to the judge so it grades against real data, not vibes. */
  groundTruthSql?: string;
  /** Deterministic: the agent's final successful SELECT must return this many rows. */
  expectRowCount?: number;
  /** Deterministic: the answer must contain each of these (case-insensitive). */
  expectAnswerContains?: string[];
  /** Deterministic: the answer must contain NONE of these — the RLS-leak guard. */
  expectAnswerOmits?: string[];
  /** Deterministic: the answer must name each of these tables (citation check). */
  mustCiteTables?: string[];

  /** Rubric for the LLM judge. If set, the judge scores answer correctness. */
  judge?: string;

  /** Soft budgets — exceed and the budget dimension fails. */
  maxToolCalls?: number;
  maxCostUsd?: number;
}

export interface Task {
  id: string;
  category: string;
  prompt: string;
  /** Email to act as (RLS identity), or null for logged-out. */
  actingUser: string | null;
  checks: TaskChecks;
}

export type DimensionStatus = "pass" | "fail" | "skip";

/** The verdict for one scoring dimension on one task. */
export interface DimensionResult {
  dimension: string;
  status: DimensionStatus;
  detail: string;
}

/** The full scored result for one task — what the report renders. */
export interface TaskScore {
  taskId: string;
  category: string;
  prompt: string;
  actingUser: string | null;
  /** Overall pass = no dimension failed (skips don't count against). */
  passed: boolean;
  dimensions: DimensionResult[];
  answer: string;
  /** Compact tool trace for the report (full detail lives in the AgentResult). */
  trace: { name: string; blocked: boolean; isError: boolean; summary: string }[];
  metrics: {
    toolCalls: number;
    iterations: number;
    costUsd: number;
    latencyMs: number;
  };
}
