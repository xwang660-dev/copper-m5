// @vitest-environment node
// `npm run eval`: asks Ask Copper every question in the golden set, once for
// each agent setup (two agents, and one single agent with every tool), has the
// AI judge grade each answer, sends the scores to Langfuse, and fails when too
// few answers pass. It runs the real model, so it needs the Google key (and
// the Langfuse keys, to keep the scores). GitHub Actions runs it on every pull
// request and shows the comparison on the pull request.
import { appendFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyDesk, GOLDEN_SET, type GoldenCase } from "@/evals/golden-set";
import { judge, PASS_SCORE, toolsOk, type Answer } from "@/evals/judge";
import { buildReport, type CaseResult, summarize } from "@/evals/report";
import { postScore } from "@/evals/scores";
import { AGENT_MODE, ALL_VARIANTS, type Variant } from "@/evals/variants";
import { isAiConfigured, usageMeter } from "@/lib/ai/call";
import { flushTraces, langfuseEnabled } from "@/lib/ai/langfuse";
import { registerLangfuse } from "@/lib/ai/langfuse-register";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";

/** At least this share of cases must pass. Models vary a little run to run. */
const MIN_PASS_RATE = Number(process.env.EVAL_MIN_PASS_RATE ?? "0.8");
/** Names this run in Langfuse, to find its traces and scores. */
const RUN = process.env.EVAL_RUN ?? `local-${new Date().toISOString()}`;
/** EVAL_VARIANTS=two-agents,single-agent picks the setups to grade. */
const VARIANTS = (process.env.EVAL_VARIANTS?.split(",").map((v) => v.trim()) ??
  ALL_VARIANTS) as Variant[];
/** The setup the app ships today. CI holds this one to the pass-rate bar. */
const GATE = (process.env.EVAL_GATE_VARIANT ?? "two-agents") as Variant;
/** Wait between questions, in ms, to stay under the rate limit. */
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? "4000");
/** EVAL_ONLY=id1,id2 runs just those cases (to look into a failure). */
const ONLY = process.env.EVAL_ONLY?.split(",").map((id) => id.trim());

const results = new Map<Variant, CaseResult[]>(VARIANTS.map((v) => [v, []]));

async function runOnce(
  golden: GoldenCase,
  variant: Variant,
): Promise<CaseResult> {
  const before = { ...usageMeter };
  const started = performance.now();
  const { progress, traceId } = await askCopper({
    messages: [{ role: "user", content: golden.question }],
    useTools: true,
    desk: golden.desk ?? emptyDesk(),
    agent: golden.agent,
    agentMode: AGENT_MODE[variant],
    traceLabels: { evalRun: RUN, variant, caseId: golden.id },
  });
  const final = await finalValue(progress);
  const seconds = (performance.now() - started) / 1000;
  // What the answer cost, before the judge's own call is added to the meter.
  const costUsd = usageMeter.costUsd - before.costUsd;
  const tokens =
    usageMeter.inputTokens +
    usageMeter.outputTokens -
    (before.inputTokens + before.outputTokens);
  if (final.status === "error" || APOLOGY.test(final.reply))
    throw new Error("The chat ended with an error or an empty reply.");
  const answer: Answer = { reply: final.reply, tools: toolCallsOf(final) };
  const verdict = await judge(golden, answer);
  const tools = toolsOk(golden, answer, variant);
  const pass = tools && verdict.score >= PASS_SCORE;

  // The chat has already sent its trace, so the scores can attach to it.
  if (traceId) {
    const comment = `${variant} · ${RUN} · ${golden.id}`;
    await Promise.all([
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
  }
  return {
    id: golden.id,
    pass,
    score: verdict.score,
    tools,
    reason: verdict.reason,
    costUsd,
    seconds,
    tokens,
  };
}

/** The chat's fallback when the model gave nothing back (see ask.ts). */
const APOLOGY = /something went wrong on my end/i;

/** Quota and rate-limit errors need a longer wait than other hiccups. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tries a case up to four times, waiting longer each time. A busy or
 * rate-limited model service (an error, or an empty reply that the chat turns
 * into an apology) says nothing about the answers, so it is retried and not
 * graded. A wrong answer is never retried.
 */
async function runCase(
  golden: GoldenCase,
  variant: Variant,
): Promise<CaseResult> {
  for (const wait of [10_000, 30_000, 60_000]) {
    try {
      return await runOnce(golden, variant);
    } catch {
      await sleep(wait);
    }
  }
  return runOnce(golden, variant);
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

  for (const variant of VARIANTS)
    describe(variant, () => {
      for (const golden of GOLDEN_SET.filter(
        (g) => !ONLY || ONLY.includes(g.id),
      ))
        it(
          golden.id,
          async () => {
            const result = await runCase(golden, variant);
            results.get(variant)?.push(result);
            // Stay under the model service's requests-per-minute limit.
            await sleep(PAUSE_MS);
            // Only the shipped setup fails the run on a bad case; the other
            // is being compared, and its numbers go in the report.
            if (variant === GATE)
              expect(
                result.pass,
                `${result.reason} (judge ${result.score}/5, tools ${result.tools ? "ok" : "wrong"})`,
              ).toBe(true);
          },
          300_000,
        );
    });

  it("passes enough of the golden set", async () => {
    await flushTraces();
    const report = buildReport({
      run: RUN,
      variants: VARIANTS.map((variant) => ({
        variant,
        cases: results.get(variant) ?? [],
      })),
      minPassRate: MIN_PASS_RATE,
      gate: GATE,
    });
    console.info(`\n${report}\n`);
    // CI posts this file as a comment on the pull request.
    writeFileSync("eval-report.md", report);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    if (!langfuseEnabled())
      console.info("Langfuse keys not set: scores were not sent.");
    expect(
      summarize({ variant: GATE, cases: results.get(GATE) ?? [] }).passRate,
    ).toBeGreaterThanOrEqual(MIN_PASS_RATE);
  });
});
