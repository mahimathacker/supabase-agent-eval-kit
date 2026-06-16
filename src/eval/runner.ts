// The eval loop: load tasks -> for each, run the agent then score it ->
// write a Markdown report and print a summary. Runs tasks sequentially so the
// console trace is readable and we don't spawn a swarm of MCP servers / hammer
// the API at once.
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "../agent/runAgent.js";
import { closePool } from "../tools/db.js";
import { renderReport } from "./report.js";
import { scoreTask } from "./score.js";
import type { Task, TaskScore } from "./types.js";

function tasksPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "tasks.json");
}

export async function loadTasks(): Promise<Task[]> {
  return JSON.parse(await readFile(tasksPath(), "utf8")) as Task[];
}

export async function runEval(opts: { only?: string; out: string }): Promise<void> {
  let tasks = await loadTasks();
  if (opts.only) tasks = tasks.filter((t) => t.id === opts.only);
  if (tasks.length === 0) {
    console.error(opts.only ? `No task with id "${opts.only}".` : "No tasks found.");
    process.exitCode = 1;
    return;
  }

  const scores: TaskScore[] = [];
  try {
    for (const task of tasks) {
      process.stderr.write(
        `\n▶ [${task.id}] ${task.category} — acting as ${task.actingUser ?? "anon"}\n`,
      );
      const result = await runAgent(task.prompt, { actingUser: task.actingUser });
      const score = await scoreTask(task, result);
      scores.push(score);

      process.stderr.write(
        `  ${score.passed ? "PASS" : "FAIL"}  ` +
          `(${score.metrics.toolCalls} tools, $${score.metrics.costUsd.toFixed(4)}, ${score.metrics.latencyMs}ms)\n`,
      );
      for (const d of score.dimensions) {
        if (d.status === "fail") process.stderr.write(`    ✗ ${d.dimension}: ${d.detail}\n`);
      }
    }
  } finally {
    // groundTruth opened a pool in THIS process (separate from the MCP servers).
    await closePool();
  }

  const stamp = new Date().toISOString();
  const md = renderReport(scores, stamp);
  await mkdir(opts.out, { recursive: true });
  const file = path.join(opts.out, `eval-${stamp.replace(/[:.]/g, "-")}.md`);
  await writeFile(file, md, "utf8");

  const passed = scores.filter((s) => s.passed).length;
  const cost = scores.reduce((a, s) => a + s.metrics.costUsd, 0);
  process.stderr.write(
    `\n${passed}/${scores.length} passed · $${cost.toFixed(4)} total\nReport: ${file}\n`,
  );
  if (passed < scores.length) process.exitCode = 1;
}
