// Eval CLI entry point (`npm run eval`).
//   npm run eval                      run the whole task set
//   npm run eval -- --only rls-tickets-member   run one task by id
//   npm run eval -- --out ./reports   choose the report directory
import "dotenv/config";
import { Command } from "commander";
import { runEval } from "./eval/runner.js";

const program = new Command();
program
  .name("supabase-agent-eval")
  .description("Run the agent against the task set and score the results.")
  .option("--only <id>", "run a single task by id")
  .option("--out <dir>", "directory to write the Markdown report into", "reports")
  .parse();

const opts = program.opts<{ only?: string; out: string }>();

runEval({ only: opts.only, out: opts.out }).catch((e) => {
  console.error(e);
  process.exit(1);
});
