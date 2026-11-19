// Next.js calls register() once when the server starts. It turns on Langfuse
// tracing when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerLangfuse } = await import("./lib/ai/langfuse-register");
  registerLangfuse();
}
