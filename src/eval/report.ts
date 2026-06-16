// Renders the scored results into a single Markdown report: a summary up top
// (pass rate, per-category, cost/latency) and a detailed section per task with
// the dimensions table, tool trace, failure reasons, and the agent's answer.
import type { TaskScore } from "./types.js";

const icon = (status: string) => (status === "pass" ? "✅" : status === "fail" ? "❌" : "➖");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderReport(scores: TaskScore[], stampIso: string): string {
  const total = scores.length;
  const passed = scores.filter((s) => s.passed).length;
  const cost = scores.reduce((a, s) => a + s.metrics.costUsd, 0);
  const ms = scores.reduce((a, s) => a + s.metrics.latencyMs, 0);
  const tools = scores.reduce((a, s) => a + s.metrics.toolCalls, 0);

  const byCat = new Map<string, { p: number; n: number }>();
  for (const s of scores) {
    const c = byCat.get(s.category) ?? { p: 0, n: 0 };
    c.n++;
    if (s.passed) c.p++;
    byCat.set(s.category, c);
  }

  const L: string[] = [];
  L.push(`# Supabase Agent Eval Report`, ``);
  L.push(`_${stampIso}_`, ``);
  L.push(
    `**${passed}/${total} tasks passed** · total cost $${cost.toFixed(4)} · ` +
      `total time ${(ms / 1000).toFixed(1)}s · ${tools} tool calls`,
    ``,
  );

  L.push(`## By category`, ``, `| Category | Passed |`, `| --- | --- |`);
  for (const [c, v] of byCat) L.push(`| ${c} | ${v.p}/${v.n} |`);
  L.push(``);

  L.push(
    `## By task`,
    ``,
    `| Task | Result | Tools | Cost | Latency |`,
    `| --- | --- | --- | --- | --- |`,
  );
  for (const s of scores) {
    L.push(
      `| \`${s.taskId}\` | ${s.passed ? "✅" : "❌"} | ${s.metrics.toolCalls} | ` +
        `$${s.metrics.costUsd.toFixed(4)} | ${(s.metrics.latencyMs / 1000).toFixed(1)}s |`,
    );
  }
  L.push(``, `---`, ``);

  for (const s of scores) {
    L.push(`## ${s.passed ? "✅ PASS" : "❌ FAIL"} — \`${s.taskId}\`  _(${s.category})_`, ``);
    L.push(`**Acting as:** ${s.actingUser ?? "anon (logged out)"}  `);
    L.push(`**Task:** ${esc(s.prompt)}`, ``);

    L.push(`**Dimensions**`, ``, `| Dimension | Status | Detail |`, `| --- | --- | --- |`);
    for (const d of s.dimensions) L.push(`| ${d.dimension} | ${icon(d.status)} | ${esc(d.detail)} |`);
    L.push(``);

    L.push(`**Tool trace**`, ``);
    if (s.trace.length === 0) {
      L.push(`_(no tool calls)_`, ``);
    } else {
      s.trace.forEach((t, i) => {
        const flags = [t.isError ? "ERROR" : null, t.blocked ? "BLOCKED" : null]
          .filter(Boolean)
          .join(",");
        L.push(`${i + 1}. \`${t.name}\`${flags ? ` **[${flags}]**` : ""}${t.summary ? ` — ${esc(t.summary)}` : ""}`);
      });
      L.push(``);
    }

    const failed = s.dimensions.filter((d) => d.status === "fail");
    if (failed.length) {
      L.push(`**Why it failed:** ${failed.map((d) => `${d.dimension} — ${esc(d.detail)}`).join("; ")}`, ``);
    }

    const answer = s.answer.slice(0, 1500) + (s.answer.length > 1500 ? " …" : "");
    L.push(`**Answer**`, ``, `> ${answer.replace(/\n/g, "\n> ")}`, ``, `---`, ``);
  }

  return L.join("\n");
}
