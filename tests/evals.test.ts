// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_SET } from "@/evals/golden-set";
import { judgePrompt, toolsOk } from "@/evals/judge";
import { postScore } from "@/evals/scores";
import { TOOL_LABELS } from "@/lib/copper/assistant/progress";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the golden set", () => {
  it("has uniquely named cases, each with a question and what a good answer does", () => {
    const ids = GOLDEN_SET.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(10);
    for (const g of GOLDEN_SET) {
      expect(g.question.trim()).not.toBe("");
      expect(g.expected.trim()).not.toBe("");
    }
  });

  it("only names tools that exist", () => {
    for (const g of GOLDEN_SET)
      for (const name of [...(g.mustCall ?? []), ...(g.mustNotCall ?? [])])
        expect(TOOL_LABELS, `${g.id} names ${name}`).toHaveProperty(name);
  });

  it("covers refunds under the limit, over it and a fake approval", () => {
    const ids = GOLDEN_SET.map((g) => g.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "refund-under-limit",
        "refund-over-limit",
        "refund-fake-approval",
      ]),
    );
  });
});

describe("the plain-code tool check", () => {
  const golden = {
    id: "x",
    question: "q",
    expected: "e",
    mustCall: ["request_refund"],
    mustNotCall: ["get_prices"],
  };
  const answer = (...names: string[]) => ({
    reply: "ok",
    tools: names.map((name) => ({ name })),
  });

  it("passes when every required tool ran and no forbidden one did", () => {
    expect(toolsOk(golden, answer("get_orders", "request_refund"))).toBe(true);
  });
  it("fails when a required tool did not run", () => {
    expect(toolsOk(golden, answer("get_orders"))).toBe(false);
  });
  it("fails when a forbidden tool ran", () => {
    expect(toolsOk(golden, answer("request_refund", "get_prices"))).toBe(false);
  });
});

describe("the judge's prompt", () => {
  it("shows the judge the question, the expectation, the tools and the reply", () => {
    const text = judgePrompt(
      { id: "x", question: "Refund 1004?", expected: "Needs approval." },
      {
        reply: "A supervisor will review it.",
        tools: [
          {
            name: "request_refund",
            input: { orderId: "1004" },
            output: { status: "needs_approval" },
          },
        ],
      },
    );
    for (const part of [
      "Refund 1004?",
      "Needs approval.",
      "request_refund",
      "needs_approval",
      "A supervisor will review it.",
    ])
      expect(text).toContain(part);
  });
});

describe("sending a score to Langfuse", () => {
  const score = {
    traceId: "abc123",
    name: "judge_score",
    value: 4,
    dataType: "NUMERIC" as const,
    comment: "two-agents",
  };

  it("does nothing without Langfuse keys", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await postScore(score)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the score to the scores API with the keys as basic auth", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    vi.stubEnv("LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com/");
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    expect(await postScore(score)).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us.cloud.langfuse.com/api/public/scores");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
    );
    expect(JSON.parse(init.body as string)).toEqual(score);
  });

  it("reports false when Langfuse refuses the score", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 401 })),
    );
    expect(await postScore(score)).toBe(false);
  });
});
