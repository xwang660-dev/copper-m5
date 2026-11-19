// @vitest-environment node
// `npm run eval`: asks Ask Copper every question in the golden set, has the AI
// judge grade each answer, sends the scores to Langfuse, and fails when too
// few answers pass. It runs the real model, so it needs the Google key (and
// the Langfuse keys, to keep the scores). GitHub Actions runs it on every
// pull request.
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyDesk, GOLDEN_SET, type GoldenCase } from "@/evals/golden-set";
import { judge, PASS_SCORE, toolsOk, type Answer } from "@/evals/judge";
import { postScore } from "@/evals/scores";
import { isAiConfigured } from "@/lib/ai/call";
import { flushTraces, langfuseEnabled } from "@/lib/ai/langfuse";
import { registerLangfuse } from "@/lib/ai/langfuse-register";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";

/** At least this share of cases must pass. Models vary a little run to run. */
const MIN_PASS_RATE = Number(process.env.EVAL_MIN_PASS_RATE ?? "0.8");
/** Names this run in Langfuse, to find its traces and scores. */
const RUN = process.env.EVAL_RUN ?? `local-${new Date().toISOString()}`;
/** Which agent setup is being graded (Part 4 compares two). */
const VARIANT = process.env.EVAL_VARIANT ?? "two-agents";
/** EVAL_ONLY=id1,id2 runs just those cases (to look into a failure). */
const ONLY = process.env.EVAL_ONLY?.split(",").map((id) => id.trim());

type Result = {
  id: string;
  pass: boolean;
  score: number;
  tools: boolean;
  reason: string;
  traced: boolean;
};
const results: Result[] = [];

async function runOnce(golden: GoldenCase): Promise<Result> {
  const { progress, traceId } = await askCopper({
    messages: [{ role: "user", content: golden.question }],
    useTools: true,
    desk: golden.desk ?? emptyDesk(),
    agent: golden.agent,
    traceLabels: { evalRun: RUN, variant: VARIANT, caseId: golden.id },
  });
  const final = await finalValue(progress);
  if (final.status === "error")
    throw new Error("The chat ended with an error.");
  const answer: Answer = { reply: final.reply, tools: toolCallsOf(final) };
  const verdict = await judge(golden, answer);
  const tools = toolsOk(golden, answer);
  const pass = tools && verdict.score >= PASS_SCORE;

  // The chat has already sent its trace, so the scores can attach to it.
  let traced = false;
  if (traceId) {
    const comment = `${VARIANT} · ${RUN} · ${golden.id}`;
    const sent = await Promise.all([
      postScore({
        traceId,
        name: "judge_score",
        value: verdict.score,
        dataType: "NUMERIC",
        comment: `${comment}: ${verdict.reason}`,
      }),
      postScore({
        traceId,
        name: "tools_ok",
        value: tools ? 1 : 0,
        dataType: "BOOLEAN",
        comment,
      }),
      postScore({
        traceId,
        name: "case_pass",
        value: pass ? 1 : 0,
        dataType: "BOOLEAN",
        comment,
      }),
    ]);
    traced = sent.every(Boolean);
  }
  return {
    id: golden.id,
    pass,
    score: verdict.score,
    tools,
    reason: verdict.reason,
    traced,
  };
}

/**
 * Tries a case up to three times, waiting longer each time: a busy model
 * service shouldn't fail the whole run. A wrong answer is not retried, only a
 * chat that ended with an error.
 */
async function runCase(golden: GoldenCase): Promise<Result> {
  for (const wait of [8_000, 20_000]) {
    try {
      return await runOnce(golden);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return runOnce(golden);
}

function summary(): string {
  const passed = results.filter((r) => r.pass).length;
  const lines = [
    `## Golden set: ${VARIANT}`,
    "",
    `Run \`${RUN}\`: ${passed} of ${results.length} passed (needs ${Math.round(MIN_PASS_RATE * 100)}%).`,
    "",
    "| Case | Result | Judge | Tools | Why |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.pass ? "pass" : "FAIL"} | ${r.score}/5 | ${r.tools ? "ok" : "wrong"} | ${r.reason.replace(/\|/g, "/")} |`,
    ),
  ];
  return lines.join("\n");
}

describe("golden set", () => {
  if (!isAiConfigured()) {
    // On a laptop, no key just means no eval. In CI it must not pass quietly.
    if (process.env.CI)
      it("has the Google key", () => {
        throw new Error(
          "GOOGLE_GENERATIVE_AI_API_KEY is missing: add it to the repo's Actions secrets.",
        );
      });
    else it.skip("needs GOOGLE_GENERATIVE_AI_API_KEY in .env.local");
    return;
  }

  registerLangfuse();

  describe("each question", () => {
    for (const golden of GOLDEN_SET.filter((g) => !ONLY || ONLY.includes(g.id)))
      it(
        golden.id,
        async () => {
          const result = await runCase(golden);
          results.push(result);
          expect(
            result.pass,
            `${result.reason} (judge ${result.score}/5, tools ${result.tools ? "ok" : "wrong"})`,
          ).toBe(true);
        },
        180_000,
      );
  });

  it("passes enough of the golden set", async () => {
    await flushTraces();
    const text = summary();
    console.info(`\n${text}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    if (!langfuseEnabled())
      console.info("Langfuse keys not set: scores were not sent.");
    const rate =
      results.filter((r) => r.pass).length / Math.max(results.length, 1);
    expect(rate).toBeGreaterThanOrEqual(MIN_PASS_RATE);
  });
});
