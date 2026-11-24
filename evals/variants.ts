// The two agent setups the evals compare (Module 5, Part 4).
import type { AskCopperRequest } from "@/lib/copper/assistant/ask";

/** two-agents: Copper hands refunds to the Refund agent. single-agent: one agent, every tool, no handoff. */
export type Variant = "two-agents" | "single-agent";

export const ALL_VARIANTS: Variant[] = ["two-agents", "single-agent"];

export const AGENT_MODE: Record<
  Variant,
  NonNullable<AskCopperRequest["agentMode"]>
> = {
  "two-agents": "multi",
  "single-agent": "single",
};
