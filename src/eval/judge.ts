import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM-as-judge for free-form answer correctness. Deterministic checks can't tell
 * whether "There are 5 customers across 3 plans" correctly answers a counting
 * task — formatting varies, prose varies. The judge can, especially when handed
 * the canonical result computed directly from the DB.
 *
 * We keep the judge STRICT and grounded: grade only against the rubric and the
 * canonical data, fail fluent-but-unsupported answers, and return a single JSON
 * verdict. Using a separate model call (not the agent) is the point — an
 * independent grader, not the student marking its own work.
 */
export interface JudgeVerdict {
  pass: boolean;
  reasoning: string;
}

// A strong grader is worth it for trustworthy scores; override for cheaper runs.
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-opus-4-8";

const SYSTEM = `You are a strict grader for an AI agent that answers questions about a database.
Judge ONLY whether the agent's answer satisfies the task and the rubric, grounded in the evidence provided.
- Do not reward fluent but unsupported answers.
- If a canonical result is provided and the answer contradicts it (wrong numbers, missing or invented rows), fail.
- Minor formatting/wording differences are fine if the substance is correct.
Respond with EXACTLY one JSON object and nothing else: {"verdict": "pass" | "fail", "reasoning": "<one or two sentences>"}.`;

export async function judgeAnswer(args: {
  prompt: string;
  answer: string;
  rubric: string;
  groundTruthRows?: Record<string, unknown>[];
}): Promise<JudgeVerdict> {
  const anthropic = new Anthropic();

  const canonical = args.groundTruthRows
    ? `\n\nCANONICAL RESULT (computed directly from the database for the same user — the answer must be consistent with this):\n${JSON.stringify(
        args.groundTruthRows,
        null,
        2,
      ).slice(0, 4000)}`
    : "";

  const user = `TASK:\n${args.prompt}\n\nRUBRIC (what counts as correct):\n${args.rubric}${canonical}\n\nAGENT'S ANSWER:\n${args.answer}\n\nReturn the JSON verdict now.`;

  const resp = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1000,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { pass: false, reasoning: `Judge returned no JSON: ${text.slice(0, 200)}` };
  try {
    const obj = JSON.parse(match[0]) as { verdict?: string; reasoning?: string };
    return { pass: obj.verdict === "pass", reasoning: String(obj.reasoning ?? "") };
  } catch {
    return { pass: false, reasoning: `Judge JSON parse failed: ${text.slice(0, 200)}` };
  }
}
