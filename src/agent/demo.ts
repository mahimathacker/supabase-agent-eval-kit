// Watch the agent run on a single ad-hoc task. This is a Layer 2 harness for
// eyeballing behavior; Layer 4 will run the curated task set and score it.
//
// Usage:
//   npm run agent -- "How many customers are on each plan?"
//   npm run agent -- --user=bob@acme.test "List every ticket you can see"
//   npm run agent -- --user=none "List every ticket you can see"   (logged out)
import "dotenv/config";
import { runAgent } from "./runAgent.js";

function parseArgs(argv: string[]): { task: string; actingUser: string | null } {
  let actingUser: string | null = process.env.ACTING_USER ?? "alice@acme.test";
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--user=")) {
      const v = arg.slice("--user=".length);
      actingUser = v === "none" || v === "" ? null : v;
    } else {
      rest.push(arg);
    }
  }
  return { task: rest.join(" ").trim(), actingUser };
}

async function main() {
  const { task, actingUser } = parseArgs(process.argv.slice(2));
  if (!task) {
    console.error('Usage: npm run agent -- [--user=email|none] "<task>"');
    process.exit(1);
  }

  console.error(`\n▶ task: ${task}`);
  console.error(`▶ acting as: ${actingUser ?? "(anon / logged out)"}\n`);

  const result = await runAgent(task, { actingUser });

  console.log("─".repeat(70));
  console.log("TOOL TRACE");
  console.log("─".repeat(70));
  if (result.toolCalls.length === 0) {
    console.log("(no tool calls — the agent answered from the prompt alone)");
  }
  result.toolCalls.forEach((c, i) => {
    const flags = [c.isError ? "ERROR" : null, c.blocked ? "BLOCKED" : null]
      .filter(Boolean)
      .join(",");
    const arg =
      typeof c.input === "object" && c.input
        ? JSON.stringify(c.input).slice(0, 80)
        : "";
    console.log(`${i + 1}. ${c.name}${flags ? ` [${flags}]` : ""}  ${arg}  (${c.latencyMs}ms)`);
  });

  console.log("\n" + "─".repeat(70));
  console.log("ANSWER");
  console.log("─".repeat(70));
  console.log(result.answer || "(empty)");

  console.log("\n" + "─".repeat(70));
  console.log("METRICS");
  console.log("─".repeat(70));
  console.log(`tool calls : ${result.toolCalls.length}`);
  console.log(`model turns: ${result.iterations}  (stop_reason: ${result.stopReason})`);
  console.log(
    `tokens     : in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
      `cacheR=${result.usage.cacheReadTokens} cacheW=${result.usage.cacheCreationTokens}`,
  );
  console.log(`cost       : $${result.costUsd.toFixed(4)}`);
  console.log(`latency    : ${result.latencyMs}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
