# Devpost submission draft — Cafe Copilot

Built for the **CockroachDB × AWS AI Hackathon**.

## Project name

Cafe Copilot

## Tagline

Ask your till a question and get an honest, plain-language answer — powered by CockroachDB
memory and Amazon Bedrock.

## Try it out

The supported, judged path is the authenticated widget embedded in the Project POS manager
dashboard — not a public no-login page. See `docs/DEMO_SCRIPT.md` for the exact click path and
question order. In short:

1. Open the POS staging dashboard: `https://phase-8-auth.project-pos.pages.dev`
2. Sign in with the dedicated staging demo-owner credentials supplied privately to judges
   (Row-Level Security confines this account to the fictional "Harbour & Bean Demo Café" only).
3. Enter the staging demo-owner PIN, open the manager dashboard, and click the floating Copilot button.

[OWNER TO SUPPLY: public video URL]

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

Cafe Copilot is a plain-language AI assistant for a small café owner, embedded as a floating
widget in the Project POS manager dashboard. It answers questions computed live from the
café's real point-of-sale data — daily sales, cash reconciliation, staff performance and
accountability, waste and comp logs — and it remembers: past conversations, notes the owner
asks it to keep ("we switch to the winter menu in November"), and a rolling memory of daily
summaries it can search by meaning, not just by date, so "have we had any refund problems
lately?" surfaces the right day even without the owner naming it. It can also draft a purchase
order for the owner to review — never submits anything automatically. The agent never writes to
the POS; the POS stays the single source of truth for every number it states.

## How we built it

**CockroachDB is the persistent memory layer**, not an add-on. Every conversation, every note,
every draft, and 21 vector-indexed daily-summary documents (one per seeded demo day, embedded
via Titan Text Embeddings v2 and stored with a real `CREATE VECTOR INDEX`) live in a single
CockroachDB cluster, spanning tables `conversations`, `messages`, `notes`, `drafts`, and
`documents`, plus a `schema_migrations` ledger. Two CockroachDB tools/features power this:

1. **Distributed Vector Indexing** — the `documents` table's native `VECTOR` column with a real
   `CREATE VECTOR INDEX` (`documents_embedding_idx`), queried with the cosine operator `<=>` in
   `memory/store.mjs`'s `searchDocuments`. No separate vector store, no reindexing pipeline. We
   proved this concretely in `memory/verify.mjs`: embed "cold brew sales" and "croissant waste"
   as two tiny documents, then embed and search "coffee drinks" — the vector index correctly
   ranks "cold brew sales" first, purely on meaning, not keyword overlap. In the live demo, the
   same mechanism is what lets the agent answer "have we had any problems with refunds lately?"
   by retrieving the flagged refund-spike summary without the owner naming the date — the
   flagship CockroachDB moment in the demo.
2. **CockroachDB Agent Skills Repo** — we applied the official `cockroachdb-sql` skill to the
   memory schema, migrations, and query layer during the release audit. Its CockroachDB-specific
   rules checked UUID primary keys, fixed-width vectors, tenant-scoped queries, atomic conflict
   handling, distributed-read bounds, and the need for `EXPLAIN` validation before scaling. The
   versioned findings are in `docs/COCKROACHDB_SKILL_AUDIT.md`.

As a bonus, `ops/crdb-health.mjs` is a small, unit-tested, read-only CockroachDB Cloud health
probe over the `ccloud` CLI (noun-verb syntax, JSON output) — wired and tested, optional at
runtime since it needs `ccloud` installed and authenticated.

**AWS runs the agent.** Amazon Bedrock's Converse Stream API drives the tool-calling loop with
Claude Sonnet 4.5 — the agent plans, calls tools (`get_day_summary`, `get_staff_performance`,
`get_waste_log`, `search_memory`, `save_note`, `list_notes`, `draft_purchase_order`), and
streams its answer back token by token. Titan Text Embeddings v2 (also via Bedrock) produces
the vectors behind `search_memory`. The whole backend runs as a single **AWS Lambda**
(`nodejs22.x`, 512 MB, 55 s timeout, reserved concurrency 2) behind a public Function URL in
`RESPONSE_STREAM` invoke mode, so the same Server-Sent-Events wire protocol works locally (a
plain Node dev server) and in production without any client-side branching. No static AWS
credentials are ever deployed with the function — Bedrock access is granted entirely through
the Lambda's IAM execution role, scoped to exactly `bedrock:InvokeModel*` plus its own
CloudWatch log group.

**Identity and access are real, not a shortcut.** The widget calls the agent in
`mode: "authenticated"` with a Supabase JWT and an explicit `businessId`. The backend verifies
the JWT with Supabase, then requires an ACTIVE `owner` or `manager` row in
`business_memberships` for that exact business before doing anything else. Every POS-reading
tool runs a request-scoped Supabase client carrying the caller's own JWT, so Postgres
row-level security applies to the caller, not to a shared service account. Live-verified guard
rails: `401` on a missing/invalid token, `403` on a disallowed origin, `400` on a missing or
invalid `mode`, `413` on an oversized request body.

The **web client** is a small React + Vite chat UI, embedded as a floating widget in the POS
manager dashboard, talking to the Lambda Function URL over SSE.

## Challenges we ran into

- **The October 2025 Lambda Function URL dual-permission requirement.** A public
  (`AuthType: NONE`) Lambda Function URL used to need only `lambda:InvokeFunctionUrl` in its
  resource policy; since October 2025, AWS also requires a plain `lambda:InvokeFunction` grant,
  or every unsigned request 403s even though the function itself is healthy. This was the sole
  cause of persistent 403s after the first deploy attempt — solved by adding the second
  `AddPermission` call and baking it permanently into `deploy-lambda.mjs`.
- **New-AWS-account concurrency quota.** Reserving concurrency (`PutFunctionConcurrency`) on a
  brand-new account can fail outright, because reserving any amount would drop the account's
  unreserved pool below AWS's required minimum. We made the reservation best-effort (log a
  warning, continue) rather than treating it as a hard deploy failure, since per-reply token
  caps and the request deadline already bound cost without it.
- **RPC timestamp design call for seeded demo history.** The POS's `close_till_session` and
  `record_order_adjustment` RPCs intentionally stamp `now()` and accept no historical timestamp
  — a deliberate production safety property (no backdating cash reconciliation). That's correct
  for the live product but meant a batch-seeded demo history would clump every closure and
  adjustment on the seed date instead of the intended anomaly dates. Rather than weaken the
  production RPC, we ruled to keep it untouched and instead ran a one-time, demo-business-scoped
  SQL fixup on staging after seeding, verified against the reconciled totals afterward.
  Documented as Amendment 1 in `docs/CONTRACTS.md`.
- **A shared-schema hazard found during hardening, invisible to the test suite.** A POS tenancy
  migration replaced the single-column `till_sessions.staff_id` foreign key with composite
  `(business_id, staff_id)` and `(business_id, closed_by)` constraints. That made the
  PostgREST embed in `get_staff_performance` both unresolvable by its old column hint and
  ambiguous unhinted, breaking the staff-performance tool live in production — while every unit
  test still passed, because the mocks never resolve the relationship at all. Fixed by pinning
  the FK constraint name explicitly (`staff_profiles!till_sessions_business_staff_fkey`), plus a
  regression test that asserts the embed hint string is present, so a future schema change can't
  silently reintroduce the same gap between "tests green" and "production correct."

## Accomplishments we're proud of

- A memory layer that is genuinely load-bearing: reload the browser tab mid-conversation, ask
  "what did I just ask you?", and the answer is right — because CockroachDB remembers it, not
  the tab.
- A vector-search moment that isn't a toy: the agent finds a real refund spike from a vague
  question ("have we had any problems with refunds lately?") with no date given, purely by
  semantic search over daily summaries stored in CockroachDB.
- An honesty discipline enforced at the system-prompt level, not just in the demo script: the
  agent is hard-forbidden from stating a number that didn't come from a live tool call in the
  current conversation, and it says so plainly when a day has no recorded activity rather than
  inventing numbers.
- Real authorization, not a demo-mode shortcut: the authenticated path checks a live Supabase
  JWT and an active owner/manager membership row before answering anything, and every POS read
  is scoped to the caller's own session.
- Passing tests across all three workspaces (agent, memory, web), a clean lint pass, and a
  clean production build, plus the FK-ambiguity fix above, which came with a new regression test
  specifically so the failure mode it caught can't silently return.

## What we learned

- Passing unit tests are not proof of a working integration. The `get_staff_performance` mocks
  never modeled the PostgREST embed relationship, so a real schema change (the composite FK
  migration) broke the tool in production while the test suite stayed green the whole time. The
  fix wasn't just the code change — it was a regression test that actually asserts the embed
  hint string, closing the specific gap the mocks had been hiding.
- A per-instance rate limiter is a real, working guard rail, but it is not the same claim as a
  global one — we made sure to state that difference plainly (see Honest disclosures) rather
  than let "there's a rate limiter" imply more than it does.
- CockroachDB's vector column and index genuinely remove a whole moving part (no separate
  vector store, no reindexing job, no consistency gap) — but the pgvector-familiar shorthand
  (`<=>`, `<->`, `<#>`) and the exact idempotent `CREATE VECTOR INDEX` recipe took some live
  trial-and-error to confirm rather than a single canonical reference.

## What's next

- **A shared, cross-instance rate limiter** (backed by CockroachDB or an external store) to
  replace the current per-Lambda-instance limiter, which only bounds abuse per warm instance,
  not globally.
- **Versioned Lambda deploys with a real rollback path.** Today every deploy overwrites
  `$LATEST` in place; publishing numbered versions would let an operator revert without
  rebuilding from an older commit.
- **Richer observability**: a request id correlated across every log line for one request,
  timing for the Bedrock call and each tool call, and structured (JSON) log lines instead of
  message strings, so CloudWatch Logs Insights can actually aggregate on fields like `statusCode`
  or tool name.
- **More tool coverage** — menu-level margin analysis, supplier-price comparisons across drafted
  purchase orders over time.

## Honest disclosures

- **This runs against POS staging, not production.** The agent refuses to run against any
  Supabase project other than the POS staging project (`assertStagingUrl` in
  `agent/pos-client.mjs`), by design — it will never be pointed at a live business's production
  data by accident.
- **Demo data covers a fixed historical range.** The seeded demo café's history spans a specific
  set of dates; the questions in `docs/DEMO_SCRIPT.md` are written against that fixed range, not
  a live-updating business.
- **Public, no-login demo mode is disabled; the supported path is the authenticated,
  POS-embedded widget.** `DEMO_MODE_ENABLED` is not `"true"` on the deployed function today, so
  `mode: "demo"` requests are rejected with `403`. The standalone Cloudflare Pages build
  (`cafe-copilot.pages.dev`) is not on the deployed Lambda's allowed-origin list as of this
  writing, so requests from it are rejected with `403 Origin is not allowed.` The judged,
  working path is signing into the POS staging dashboard and using the embedded widget, as
  described above.
- **The rate limiter is per-instance, not global.** `COPILOT_RATE_LIMIT_MAX_REQUESTS` is
  enforced against an in-memory map local to one warm Lambda instance. With reserved concurrency
  at 2, the practical ceiling for a single caller is therefore up to roughly twice the configured
  per-instance limit, not a hard global cap. This is a real, working guard rail — just not a
  substitute for a shared/global rate limiter.
- **No versioned Lambda rollback.** The deploy script creates and updates the function with
  `Publish: false` and never calls a publish-version API, so there is no "revert to version N"
  command today; rollback means rebuilding and redeploying from an earlier commit.

## Built with

React, Vite, Node.js, AWS Lambda, Amazon Bedrock (Claude Sonnet 4.5, Titan Text Embeddings v2),
CockroachDB, CockroachDB Vector Index, CockroachDB Agent Skills Repo, Supabase
(PostgreSQL, Auth, Row-Level Security), Cloudflare Pages, esbuild, Server-Sent Events.

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
- **The Agent Skills rules made the release review concrete.** The `cockroachdb-sql` skill
  turned broad distributed-database advice into a repeatable checklist covering keys, types,
  indexes, atomic writes, bounded reads, and execution-plan validation. A useful improvement
  would be a purpose-built vector-search review skill that explains tenant-filtered ANN plan
  tradeoffs and recommended `EXPLAIN` evidence.

## Team and eligibility

[OWNER TO SUPPLY: project start date]

[OWNER TO SUPPLY: team member name(s)]

[OWNER TO SUPPLY: country of residence / eligibility statement]

[OWNER TO SUPPLY: age / age-eligibility confirmation, if required by the hackathon rules]

[OWNER TO SUPPLY: affiliation disclosure, if required (e.g. employer, school, prior relationship to sponsors)]

[OWNER TO SUPPLY: AI-tool usage disclosure, if required by the hackathon rules]
