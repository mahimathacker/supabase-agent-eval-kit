// Scoring orchestrator: combine the deterministic scorers with the optional
// LLM judge into one TaskScore. This is the single entry point Layer 4 calls
// per task after the agent has run.
import type { AgentResult } from "../agent/types.js";
import type { DimensionResult, Task, TaskScore } from "./types.js";
import { getGroundTruth } from "./groundTruth.js";
import { judgeAnswer } from "./judge.js";
import {
  scoreAnswerDeterministic,
  scoreBudget,
  scoreCitations,
  scoreSafeExecution,
  scoreToolChoice,
  scoreValidSql,
} from "./scorers.js";

export async function scoreTask(task: Task, result: AgentResult): Promise<TaskScore> {
  const dimensions: DimensionResult[] = [];
  const add = (d: DimensionResult | null) => {
    if (d) dimensions.push(d);
  };

  // Fast, free, reproducible — read straight from the recorded trace/answer.
  add(scoreToolChoice(task, result));
  add(scoreValidSql(task, result));
  add(scoreSafeExecution(task, result));
  add(scoreCitations(task, result));
  add(scoreAnswerDeterministic(task, result));
  add(scoreBudget(task, result));

  // Semantic correctness via an independent grader, grounded in real data.
  if (task.checks.judge) {
    let groundTruthRows: Record<string, unknown>[] | undefined;
    if (task.checks.groundTruthSql) {
      const gt = await getGroundTruth(task.checks.groundTruthSql, task.actingUser);
      if (gt.ok) groundTruthRows = gt.rows;
    }
    const verdict = await judgeAnswer({
      prompt: task.prompt,
      answer: result.answer,
      rubric: task.checks.judge,
      groundTruthRows,
    });
    dimensions.push({
      dimension: "answer_correct",
      status: verdict.pass ? "pass" : "fail",
      detail: verdict.reasoning,
    });
  }

  // Overall pass = nothing failed. Skipped dimensions don't count against.
  const passed = dimensions.every((d) => d.status !== "fail");

  const summarize = (input: unknown): string => {
    if (input && typeof input === "object") {
      const o = input as Record<string, unknown>;
      if (typeof o.sql === "string") return o.sql.replace(/\s+/g, " ").slice(0, 120);
      if (typeof o.table === "string") return `table=${o.table}`;
    }
    return "";
  };

  return {
    taskId: task.id,
    category: task.category,
    prompt: task.prompt,
    actingUser: task.actingUser,
    passed,
    dimensions,
    answer: result.answer,
    trace: result.toolCalls.map((c) => ({
      name: c.name,
      blocked: c.blocked,
      isError: c.isError,
      summary: summarize(c.input),
    })),
    metrics: {
      toolCalls: result.toolCalls.length,
      iterations: result.iterations,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    },
  };
}
