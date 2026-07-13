# Devpost submission draft — Cafe Copilot

## Project name

Cafe Copilot

## Tagline

Ask your till a question and get an honest, plain-language answer — powered by CockroachDB
memory and Amazon Bedrock.

## Inspiration / the problem

Small independent café and restaurant owners run their whole business off a POS screen, but
that screen only ever shows numbers — a dashboard, a report, a grid. It doesn't answer the
actual question in an owner's head at 9pm: "Why was the till short today?" or "Are we losing
money on wastage?" Enterprise POS platforms (Toast, Square, Oracle Simphony) increasingly bolt
AI features onto exactly this gap, but that tier of product is out of reach — in cost and in
complexity — for a single-location café that just wants a straight answer in plain English.
Cafe Copilot is that straight answer: a chat interface in front of the POS's real data, built
as a companion to our own lightweight, single-location POS project.

## What it does

Cafe Copilot is a conversational agent for a café owner. It answers questions computed live
from the POS's real data — daily sales, cash reconciliation, staff performance and
accountability, waste and comp logs — and it remembers: past conversations, notes the owner
asks it to keep ("we go to the winter menu in November"), and a rolling memory of daily
summaries it can search by meaning, not just by date, so "have we had any refund problems
lately?" surfaces the right day even without the owner naming it. It can also draft a purchase
order for the owner to review — never submits anything automatically. The agent never writes to
the POS; the POS stays the single source of truth for every number it states.

## How we built it

**CockroachDB is the persistent memory layer**, not an add-on. Every conversation, every note,
every draft, and 21 vector-indexed daily-summary documents (one per seeded demo day, embedded
via Titan Text Embeddings v2 and stored with a real `CREATE VECTOR INDEX`) live in a single
CockroachDB Serverless cluster. Two CockroachDB tools/features power this:

1. **Distributed Vector Indexing** — the `documents` table's `embedding VECTOR(1024)` column
   with a native `CREATE VECTOR INDEX`, queried with the cosine operator `<=>` in
   `memory/store.mjs`'s `searchDocuments`. No separate vector store, no reindexing pipeline. We
   proved this concretely in `memory/verify.mjs`: embed "cold brew sales" and "croissant
   waste" as two tiny documents, then embed and search "coffee drinks" — the vector index
   correctly ranks "cold brew sales" first, purely on meaning, not keyword overlap. In the live
   demo, the same mechanism is what lets the agent answer "have we had problems with refunds
   lately?" by retrieving the flagged July 8th refund-spike summary without the owner naming the
   date.
2. **Cloud Managed MCP Server** — connected directly during development (read-only, fully
   audited) for agent-to-cluster work while iterating on the schema and the vector index against
   the live cluster, without a bespoke client or a separate DB driver setup in the coding
   session.

As a bonus, `ops/crdb-health.mjs` is a small, unit-tested, read-only CockroachDB Cloud health
probe over the `ccloud` CLI (noun-verb syntax, JSON output) — wired and tested, optional at
runtime since it needs `ccloud` installed and authenticated.

**AWS runs the agent.** Amazon Bedrock's Converse Stream API drives the tool-calling loop with
Claude Sonnet 4.5 — the agent plans, calls tools (`get_day_summary`, `get_staff_performance`,
`get_waste_log`, `search_memory`, `save_note`, `list_notes`, `draft_purchase_order`), and
streams its answer back token by token. Titan Text Embeddings v2 (also via Bedrock) produces
the vectors behind `search_memory`. The whole backend runs as an **AWS Lambda** behind a public
Function URL in `RESPONSE_STREAM` invoke mode — the same Server-Sent-Events wire protocol works
locally (a plain Node dev server) and in production (Lambda) without any client-side branching.
The Lambda's IAM execution role is scoped to exactly `bedrock:InvokeModel*` plus its own log
group — no static AWS credentials are ever deployed with the function.

The **web client** is a small React + Vite chat UI, deployed as a static build on Cloudflare
Pages, talking to the Lambda Function URL over SSE.

## Challenges we ran into

- **The October 2025 Function URL dual-permission requirement.** A public (`AuthType: NONE`)
  Lambda Function URL used to need only `lambda:InvokeFunctionUrl` in its resource policy; since
  October 2025, AWS also requires a plain `lambda:InvokeFunction` grant, or every unsigned
  request 403s even though the function itself is healthy (proven via a signed
  `InvokeWithResponseStream` call while debugging). This was the sole cause of persistent 403s
  after the first deploy attempt — solved by adding the second `AddPermission` call and baking
  it permanently into `deploy-lambda.mjs`.
- **New-AWS-account concurrency quota.** Reserving concurrency (`PutFunctionConcurrency`) on a
  brand-new account can fail outright because reserving any amount would drop the account's
  unreserved pool below AWS's required minimum. We made the reservation best-effort (log a
  warning, continue) rather than treating it as a hard deploy failure, since per-reply token
  caps and the billing alarm already bound cost without it.
- **RPC timestamp design call for seeded demo history.** The POS's `close_till_session` and
  `record_order_adjustment` RPCs intentionally stamp `now()` and accept no historical timestamp
  — a deliberate production safety property (no backdating cash reconciliation). That's correct
  for the live product but meant a batch-seeded demo history would clump every closure and
  adjustment on the seed date instead of the intended anomaly dates. Rather than weaken the
  production RPC, we ruled to keep it untouched and instead ran a one-time, demo-business-scoped
  SQL fixup on staging after seeding (`closed_at = opened_at + 9h30m`, adjustment
  `created_at = order.created_at + 30m`), verified against the reconciled totals afterward
  (0 wrong-day sessions, aggregate variance unchanged). Documented as Amendment 1 in
  `docs/CONTRACTS.md`.

## What's next

- **A floating copilot widget embedded directly in the POS manager dashboard**, so an owner
  never has to leave their POS tab to ask a question — this needs the public Lambda backend
  (now live) and per-business identity so the widget can be scoped to whichever café is logged
  in, rather than always pointing at the single seeded demo business.
- **Per-business identity end to end** — right now every conversation in this hackathon build
  belongs to one seeded demo café; real multi-tenant auth is tracked separately as the POS
  project's own tenancy-hardening phase.
- **More tool coverage** — menu-level margin analysis, supplier-price comparisons across drafted
  purchase orders over time.

## CockroachDB AI tools feedback (optional)

- **Vector index syntax was easy to find but easy to second-guess.** `CREATE VECTOR INDEX ... ON
  table (embedding)` worked first try against a live cluster, but coming from more established
  pgvector docs we spent a few minutes double-checking whether an `IF NOT EXISTS` guard and a
  fixed-width `VECTOR(n)` column were really all that was required — a short "this is the whole
  recipe, here's the idempotent version" example in the docs would have saved that.
- **Distance operator discoverability.** `<->` (L2), `<=>` (cosine), and `<#>` (negative inner
  product) all worked once we tried them, but we only found the confirmation by testing all
  three live against the cluster rather than from a single canonical reference page stating
  CockroachDB supports the full pgvector operator set — worth surfacing more prominently for
  anyone arriving from a Postgres/pgvector background.
- **MCP server setup was genuinely smooth.** Connecting the Cloud Managed MCP Server into the
  coding agent took a single config snippet and worked immediately in read-only/audited mode —
  this was the best first-five-minutes experience of any of the CockroachDB tooling we touched.
