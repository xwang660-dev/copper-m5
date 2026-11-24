// Turns eval results into the markdown that CI shows on the pull request:
// one table comparing the agent setups (pass rate, cost, speed) and one table
// of every case. Pure text in, text out, so it is easy to test.
import type { Variant } from "@/evals/variants";

export type CaseResult = {
  id: string;
  pass: boolean;
  /** The judge's grade, 1 to 5. */
  score: number;
  /** The plain-code tool check. */
  tools: boolean;
  reason: string;
  /** What answering cost, in US dollars (the judge's own call is not counted). */
  costUsd: number;
  /** Seconds from the question to the finished answer. */
  seconds: number;
  tokens: number;
};

export type VariantResult = { variant: Variant; cases: CaseResult[] };

/** The comment CI keeps up to date on the pull request is found by this tag. */
export const REPORT_MARKER = "<!-- copper-eval-report -->";

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export function summarize({ cases }: VariantResult) {
  const passed = cases.filter((c) => c.pass).length;
  return {
    total: cases.length,
    passed,
    passRate: cases.length ? passed / cases.length : 0,
    avgScore: mean(cases.map((c) => c.score)),
    avgCostUsd: mean(cases.map((c) => c.costUsd)),
    avgSeconds: mean(cases.map((c) => c.seconds)),
    avgTokens: mean(cases.map((c) => c.tokens)),
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const usd = (n: number) => `$${n.toFixed(5)}`;
const clean = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ");

export function buildReport(options: {
  run: string;
  variants: VariantResult[];
  /** The share of cases that must pass. */
  minPassRate: number;
  /** The setup the app ships today: the one CI holds to the bar. */
  gate: Variant;
}): string {
  const { run, variants, minPassRate, gate } = options;
  const lines = [
    REPORT_MARKER,
    "## Eval: golden set graded by an AI judge",
    "",
    `Run \`${run}\`. The \`${gate}\` setup must pass at least ${pct(minPassRate)} of the cases to merge. Scores are also in Langfuse, on each answer's trace.`,
    "",
    "### Single agent vs multi agent",
    "",
    "| Setup | Passed | Pass rate | Judge (avg of 5) | Cost per question | Time per question | Tokens per question |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of variants) {
    const s = summarize(result);
    lines.push(
      `| ${result.variant}${result.variant === gate ? " (shipped)" : ""} | ${s.passed} of ${s.total} | ${pct(s.passRate)} | ${s.avgScore.toFixed(2)} | ${usd(s.avgCostUsd)} | ${s.avgSeconds.toFixed(1)} s | ${Math.round(s.avgTokens)} |`,
    );
  }
  for (const result of variants) {
    lines.push(
      "",
      `### ${result.variant}`,
      "",
      "| Case | Result | Judge | Tools | Cost | Time | Why |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...result.cases.map(
        (c) =>
          `| ${c.id} | ${c.pass ? "pass" : "**FAIL**"} | ${c.score}/5 | ${c.tools ? "ok" : "wrong"} | ${usd(c.costUsd)} | ${c.seconds.toFixed(1)} s | ${clean(c.reason)} |`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
