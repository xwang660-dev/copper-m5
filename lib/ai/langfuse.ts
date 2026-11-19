// Langfuse tracing (observability) for Ask Copper. Every chat turn becomes one
// trace: a root span for the turn, one generation per agent call (model,
// tokens, cost in dollars, how long it took) and one tool span per tool call.
// With no Langfuse keys in .env.local, every function here does nothing, so
// the app runs exactly as before.
import {
  type LangfuseGeneration,
  type LangfuseSpan,
  startObservation,
} from "@langfuse/tracing";

/** The keys are in .env.local: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. */
export function langfuseEnabled(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

// A turn's root span; a generation hangs under it. The OpenTelemetry context
// is passed by hand, so a trace never depends on what else is running.
export type TraceParent = LangfuseSpan;

type Usage = { inputTokens?: number; outputTokens?: number };

export type ToolTrace = {
  /** Ends the tool span with what the tool returned, or the error. */
  end: (result: { output?: unknown; error?: string }) => void;
};

export type GenerationTrace = {
  /** Starts a tool span under this agent call. */
  tool: (name: string, input: unknown) => ToolTrace;
  /** Ends the call: tokens, cost in dollars and the answer, or the error. */
  end: (result: {
    output?: unknown;
    usage?: Usage;
    costUsd?: number | null;
    error?: string;
  }) => void;
};

export type TurnTrace = {
  /** Pass this as `parent` in the call info so calls land in this trace. */
  parent: TraceParent | undefined;
  /** The trace's id, for attaching scores to it. Undefined when tracing is off. */
  traceId: string | undefined;
  end: (result: { output?: unknown; error?: string }) => void;
};

const NO_TOOL: ToolTrace = { end: () => {} };
const NO_GENERATION: GenerationTrace = { tool: () => NO_TOOL, end: () => {} };
const NO_TURN: TurnTrace = {
  parent: undefined,
  traceId: undefined,
  end: () => {},
};

/** Starts the root span for one chat turn (the trace name is `name`). */
export function startTurn(
  name: string,
  input: unknown,
  metadata?: Record<string, unknown>,
): TurnTrace {
  if (!langfuseEnabled()) return NO_TURN;
  const span = startObservation(name, { input, metadata });
  return {
    parent: span,
    traceId: span.traceId,
    end({ output, error }) {
      span.update(
        error ? { output, level: "ERROR", statusMessage: error } : { output },
      );
      span.end();
    },
  };
}

/** Starts one model call as a generation, under `parent` when there is one. */
export function startGeneration(
  parent: TraceParent | undefined,
  attributes: {
    name: string;
    model: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  },
): GenerationTrace {
  if (!langfuseEnabled()) return NO_GENERATION;
  const { name, ...rest } = attributes;
  const generation: LangfuseGeneration = parent
    ? parent.startObservation(name, rest, { asType: "generation" })
    : startObservation(name, rest, { asType: "generation" });
  return {
    tool(toolName, input) {
      const span = generation.startObservation(
        toolName,
        { input },
        { asType: "tool" },
      );
      return {
        end({ output, error }) {
          span.update(
            error
              ? { output: error, level: "ERROR", statusMessage: error }
              : { output },
          );
          span.end();
        },
      };
    },
    end({ output, usage, costUsd, error }) {
      const input = usage?.inputTokens;
      const out = usage?.outputTokens;
      generation.update({
        output,
        ...(input !== undefined || out !== undefined
          ? {
              usageDetails: {
                ...(input !== undefined && { input }),
                ...(out !== undefined && { output: out }),
                ...(input !== undefined &&
                  out !== undefined && { total: input + out }),
              },
            }
          : {}),
        ...(costUsd !== null && costUsd !== undefined
          ? { costDetails: { total: costUsd } }
          : {}),
        ...(error ? { level: "ERROR", statusMessage: error } : {}),
      });
      generation.end();
    },
  };
}

// A streamed call returns before it ends, so the chat finds its generation
// here, to hang the tool calls under it.
const generations = new WeakMap<object, GenerationTrace>();

export function rememberGeneration(result: object, trace: GenerationTrace) {
  generations.set(result, trace);
}

export function generationFor(result: object): GenerationTrace | undefined {
  return generations.get(result);
}

type Flushable = { forceFlush: () => Promise<void> };

/** Sends the finished spans now. Serverless functions can stop right after. */
export async function flushTraces(): Promise<void> {
  const processor = (globalThis as { __langfuseProcessor?: Flushable })
    .__langfuseProcessor;
  try {
    await processor?.forceFlush();
  } catch {
    // Tracing must never break a chat.
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
