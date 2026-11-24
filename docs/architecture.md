# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF → pages → passages → Gemini embeddings → `passages.json` →
`PASSAGES` in memory. Question → `search_docs` → question embedding → 5
closest passages → Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4: Refund agent, handoff and approvals

**Summary:** On the Support page, Copper hands refund requests to a second
agent, the Refund agent, with its own instructions and tools. The app (code,
not the model) compares the order amount with an auto-refund limit you can
change: at or under it, the refund goes through; over it, the refund waits on
the Refund Console until a person clicks Approve or Reject, and the Refund
agent tells the customer.

| Piece | Where | What it does |
|---|---|---|
| Orders and the rule | `lib/copper/orders.ts`, `lib/copper/data/orders.json` | Maya Reyes's four orders (#1001 to #1004). `requestRefund()` decides: `refunded` at or under the limit, `needs_approval` over it; an order already decided keeps its status; `not_found` for unknown numbers |
| Handoffs | `lib/copper/assistant/tools.ts`, `ask.ts` | Copper's `transfer_to_refund_agent` (Support page only) and the Refund agent's `transfer_to_copper`. Each ends that agent's turn (`hasToolCall`); the other agent answers the same conversation. The agent that ends a turn answers the next message |
| Refund agent | `lib/copper/assistant/instructions.ts` (`REFUND_AGENT_INSTRUCTIONS`), `tools.ts` (`refundAgentTools`) | `get_orders` and `request_refund`, built on the desk the chat sends. Copper can't use these |
| Refund Console | `app/support/page.tsx`, `components/copper/refund-console.tsx` | The auto-refund limit ($50 to start), the refunds waiting for approval with Approve and Reject, and the orders with their status. State lives in the page: a reload starts fresh |
| Chat panel | `components/copper/ask-copper.tsx` | With `support`, sends the desk (limit and refunds so far) and the current agent with each message, puts each `request_refund` decision on the console, and sends the console's "[Refund Console] A supervisor approved …" note to the Refund agent, which tells the customer. Shows each handoff as its own station |
| AI calls | `{ module: 2, feature: "ask-copper" }`, `{ module: 4, feature: "refund-agent" }` | One call per agent in a turn |

**Data flow:** question → Copper → `transfer_to_refund_agent` → Refund agent
→ `request_refund` → the app compares the amount with the limit → refunded,
or waiting on the Refund Console → Approve or Reject → console note → Refund
agent tells the customer.

**Decisions and trade-offs:** The refund decision is code, so the model can't
argue past the limit. Two agents keep refund tools away from Copper. A real
handoff (the other agent answers) rather than an agent called as a tool keeps
one voice per reply. The console's state lives in the browser and goes with
each message, so there's nothing to set up and nothing stored on the server;
the cost is that a reload forgets every refund.

**Risks and open questions:** A customer can claim a supervisor already
approved; the Refund agent must still ask the app. Setting the limit to 0
sends every refund to a person. A real app needs a database so refunds
survive a reload and several supervisors see the same queue.

## Module 5 starter

**Summary:** Module 4 as finished. Module 5 makes Ask Copper safe to ship:
the tests and a golden-set evaluation with an AI judge run in GitHub Actions
on every pull request, with `main` protected; every AI call is traced in
Langfuse; and one support agent that does everything is compared with the two
agents on the same golden set. Langfuse is the only eval and monitoring tool.

## Module 5 Part 1: Tests in CI and a protected main

**Summary:** `.github/workflows/ci.yml` runs lint, typecheck, the tests and a
production build on Ubuntu, macOS and Windows for every push and pull request.
`main` is protected: changes go in only through a pull request, and the three
checks (`check (ubuntu-latest)`, `check (macos-latest)`,
`check (windows-latest)`) must pass and be up to date before it can merge. The
rule also applies to the repo owner, and force pushes and deleting `main` are
off. The golden-set evaluation joins the same workflow in Part 3.

**Risks and open questions:** The live Google test only runs when the key is
set; the key will go in the repo's Actions secrets when the evaluation needs
it, never in the code.

## Module 5 Part 2: Langfuse tracing

**Summary:** Every chat turn on Ask Copper is one Langfuse trace
(`ask-copper-turn`). Under it, each agent call (Copper, Refund agent) is a
generation with its model, input and output tokens, cost in US dollars and how
long it took, and each tool call (`request_refund`, `get_order`, handoffs) is a
tool span under the agent that made it. The cost comes from `lib/ai/pricing.ts`,
the same numbers as the `[ai_calls]` log line, so Langfuse needs no price table
of its own. The code is `lib/ai/langfuse.ts` (what gets recorded),
`lib/ai/langfuse-register.ts` and `instrumentation.ts` (connect it to Langfuse
when the server starts), with the hooks in `lib/ai/call.ts` and
`lib/copper/assistant/ask.ts`. Other AI calls (`callText`, `callObject`,
`callEmbedMany`) are recorded as single generations.

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in
`.env.local` (and in Vercel). Without the keys tracing is off and the app runs
as before.

**Risks and open questions:** Inputs and outputs of the chat are sent to
Langfuse as text, so the project must hold only fictional customer data. On
Vercel each span is sent at once, because a function can stop after it replies.

## Module 5 Part 3: Golden set and AI judge

**Summary:** `evals/golden-set.ts` holds 14 questions a customer really asks
(prices, totals, stock, policy with sources, an error code, off-topic, a request
for internal documents, a prompt injection, and six refund cases: under the
limit, over it, a fake "a supervisor approved it", a $0 limit, an unknown order
and a refund a person already rejected). Each has `expected` (what a good
answer does, in plain English) and optional `mustCall` / `mustNotCall` tools.
`npm run eval` (`evals/golden.eval.ts`) asks Ask Copper each question through
the real chat, then `evals/judge.ts` has Gemini grade the answer 1 to 5 against
`expected`, looking at the tool results too. A case passes when the judge gives
at least 4 and the plain-code tool check passes. The scores `judge_score`,
`tools_ok` and `case_pass` go to Langfuse on the answer's trace
(`evals/scores.ts`, the REST scores API), and the run fails when fewer than 80%
of the cases pass (`EVAL_MIN_PASS_RATE`). The judge is an ordinary model call
through `lib/ai/call.ts`, so it is logged and traced like the rest.

In GitHub Actions the `eval` job in `.github/workflows/ci.yml` runs this on
every pull request, writes the table to the run's summary, and is a required
check on `main`. The keys are the Actions secrets
`GOOGLE_GENERATIVE_AI_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_BASE_URL`. In CI a missing key fails the job instead of skipping it.
Locally the eval skips itself without a Google key. `EVAL_ONLY=id1,id2` runs
just those cases; `EVAL_VARIANT` labels the agent setup being graded.

**Risks and open questions:** The judge is a model, so scores vary a little from
run to run, which is why the bar is 80% and not 100%. The judge and the
chatbot are the same model family, which can flatter the answers. A few
test-data mistakes taught us to keep each case's `expected` about the outcome,
not about which tool the agent used: an answer built on `get_orders` is as good
as one built on `request_refund`.

## Module 5 Part 4: Single agent vs multi agent

**Summary:** The app is multi-agent: Copper hands refunds to the Refund agent,
which has its own instructions and tools. Part 4 adds a single-agent version
to compare against it: one support agent with every tool (Copper's and the
Refund agent's) and no handoff (`SINGLE_AGENT_INSTRUCTIONS` in
`lib/copper/assistant/instructions.ts`, `singleAgentTools` in `tools.ts`). It is
chosen by the `agentMode: "single"` option of `askCopper`; the Support page
always uses the default, `"multi"`, so nothing changes for customers. Both
setups use the same refund rule in `lib/copper/orders.ts`, so the app, not the
model, still decides every refund.

`npm run eval` runs the golden set on both setups. Each answer's trace in
Langfuse carries `variant` (`two-agents` or `single-agent`), `evalRun` and
`caseId` in its metadata, plus the scores, so the two can be compared there:
filter traces by `variant` for cost and latency, and scores by their comment.
The report (`evals/report.ts`) puts pass rate, average judge grade, cost,
time and tokens per question side by side. In GitHub Actions the `eval` job posts
it as one comment on the pull request (kept up to date on every push) and in
the run's summary. Cost is the answer's own model calls (read from the meter in
`lib/ai/call.ts`, not counting the judge); time is the wall-clock time from the
question to the finished answer. Only the `two-agents` setup, the one the app
ships, must reach the pass-rate bar; the single agent is reported, not gated.
`EVAL_VARIANTS` and `EVAL_GATE_VARIANT` change that.

**Risks and open questions:** Pass rates on 14 questions move by a case or two
between runs, so a small gap between the setups isn't proof. The single agent
sometimes sends `request_refund` an order id in the wrong format, then
recovers, which costs it an extra tool call. Whichever setup is shipped, keep
the refund rule in code.
