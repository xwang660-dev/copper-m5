// Sends an eval score to Langfuse, so it sits on the trace of the answer it
// grades (open the trace in Langfuse and the scores are listed beside it).
// It uses Langfuse's REST API with the keys in .env.local and does nothing
// when they are missing.
import { langfuseEnabled } from "@/lib/ai/langfuse";

export type Score = {
  traceId: string;
  /** Shown in Langfuse as the score's name, like "judge_score". */
  name: string;
  /** NUMERIC: any number. BOOLEAN: 1 or 0. */
  value: number;
  dataType: "NUMERIC" | "BOOLEAN";
  comment?: string;
};

/** Returns true when Langfuse accepted the score. */
export async function postScore(score: Score): Promise<boolean> {
  if (!langfuseEnabled()) return false;
  const base = (
    process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com"
  ).replace(/\/$/, "");
  const login = `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`;
  try {
    const response = await fetch(`${base}/api/public/scores`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(login).toString("base64")}`,
      },
      body: JSON.stringify(score),
    });
    return response.ok;
  } catch {
    return false;
  }
}
