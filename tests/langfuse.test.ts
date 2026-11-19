// @vitest-environment node
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callText } from "@/lib/ai/call";
import { langfuseEnabled, startGeneration, startTurn } from "@/lib/ai/langfuse";
import { costUsd } from "@/lib/ai/pricing";

// The spans a call would send to Langfuse, kept in memory instead.
const exporter = new InMemorySpanExporter();
let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => Object.assign(() => model, {}),
}));

function replyWith(text: string, input: number, output: number) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: input,
          noCache: input,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: output, text: output, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

/** Every attribute value of a span, as one string, to search in. */
const attributes = (span: { attributes: Record<string, unknown> }) =>
  Object.entries(span.attributes).map(([key, value]) => `${key}=${value}`);

beforeEach(() => {
  exporter.reset();
  setLangfuseTracerProvider(
    new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  );
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setLangfuseTracerProvider(null);
});

describe("Langfuse tracing", () => {
  it("is off without keys, and nothing is sent", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    expect(langfuseEnabled()).toBe(false);
    model = replyWith("Hello", 10, 5);
    const result = await callText(
      { module: 1, feature: "no-keys" },
      { prompt: "Hi" },
    );
    expect(result.text).toBe("Hello");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("sends one generation with the model, tokens, cost and time", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    model = replyWith("Hello", 1000, 200);
    await callText({ module: 1, feature: "answer" }, { prompt: "Hi" });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span.name).toBe("answer");
    const text = attributes(span).join("\n");
    expect(text).toContain("gemini-3.5-flash-lite");
    expect(text).toMatch(/usage_details.*"input":1000/);
    expect(text).toMatch(/usage_details.*"output":200/);
    // The cost comes from the app's own price table, in US dollars.
    const cost = costUsd("google/gemini-3.5-flash-lite", 1000, 200);
    expect(text).toMatch(
      new RegExp(`cost_details.*"total":${String(cost).replace(".", "\\.")}`),
    );
    // Latency is the span's start and end times.
    expect(span.endTime[0] * 1e9 + span.endTime[1]).toBeGreaterThanOrEqual(
      span.startTime[0] * 1e9 + span.startTime[1],
    );
  });

  it("hangs agent calls and tool calls under one turn", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    const turn = startTurn("ask-copper-turn", "Refund CS-1001", {
      firstAgent: "refund",
    });
    const agent = startGeneration(turn.parent, {
      name: "refund-agent",
      model: "gemini-3.5-flash-lite",
    });
    const tool = agent.tool("request_refund", { orderId: "CS-1001" });
    tool.end({ output: { status: "auto_approved" } });
    agent.end({ output: "Done", usage: { inputTokens: 5, outputTokens: 2 } });
    turn.end({ output: "Done" });

    const spans = exporter.getFinishedSpans();
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual([
      "ask-copper-turn",
      "refund-agent",
      "request_refund",
    ]);
    const parentOf = (name: string) => byName[name].parentSpanContext?.spanId;
    expect(parentOf("refund-agent")).toBe(
      byName["ask-copper-turn"].spanContext().spanId,
    );
    expect(parentOf("request_refund")).toBe(
      byName["refund-agent"].spanContext().spanId,
    );
    expect(parentOf("ask-copper-turn")).toBeUndefined();
  });

  it("records a failed call as an error", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    await expect(
      callText(
        { module: 1, feature: "fails" },
        { prompt: "Hi", maxRetries: 0 },
      ),
    ).rejects.toThrow("boom");
    const text = attributes(exporter.getFinishedSpans()[0]).join("\n");
    expect(text).toContain("ERROR");
    expect(text).toContain("boom");
  });
});
