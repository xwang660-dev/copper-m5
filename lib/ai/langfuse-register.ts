// Connects the tracing in lib/ai/langfuse.ts to Langfuse. Next.js runs
// instrumentation.ts once when the server starts, and that calls this.
// It uses its own tracer provider, so it doesn't touch Next.js's own tracing.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { langfuseEnabled } from "@/lib/ai/langfuse";

const g = globalThis as { __langfuseProcessor?: LangfuseSpanProcessor };

export function registerLangfuse() {
  if (!langfuseEnabled() || g.__langfuseProcessor) return;
  // On Vercel, send each span at once: the function may stop after a reply.
  const processor = new LangfuseSpanProcessor({
    exportMode: process.env.VERCEL ? "immediate" : "batched",
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  g.__langfuseProcessor = processor;
}
