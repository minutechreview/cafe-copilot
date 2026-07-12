# Claude track status journal (append-only)

## 2026-07-12 — repo bootstrapped
Scaffolded: LICENSE (MIT), README stub, docs/CONTRACTS.md (interface contracts + git
protocol for the dual-orchestrator build), directory skeleton (web/ agent/ memory/ owned by
Claude track; pos-sync/ demo-seed/ owned by Codex track), STATUS journals. .env.local holds
verified CRDB + AWS credentials (gitignored). CockroachDB cluster + vector indexing verified
live (CREATE VECTOR INDEX works); Bedrock access verified (121 models visible). Next on this
track: C1 app scaffold (chat UI shell, Lambda-ready agent backend, Bedrock echo round-trip)
via delegated Sonnet builder.

## 2026-07-12 — C1 scaffold done (one pending external gate)
web/ (Vite+React chat), agent/ (handler.mjs on Bedrock Converse, dev-server.mjs,
find-model.mjs → BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0 validated by
1-token probes), memory/ placeholder. 4/4 unit tests, lint clean, web build clean. Real
Bedrock connectivity proven twice, BUT full end-to-end chat is gated by an AWS account
requirement: the owner must submit the "Anthropic use case details" form in the Bedrock
console (Model access page); until then Converse calls intermittently return the
use-case-form error. After the form: re-run `node agent/scripts/find-model.mjs` (the account
catalog also shows newer Sonnet 5 ids — pick up the newest invokable), then prove the
end-to-end curl. Next Claude-track phase: C2 (CockroachDB memory schema + persistence).

## 2026-07-12 — C1 fully verified; end-to-end proof complete
Owner submitted the Anthropic use-case form; the AWS gate cleared. find-model.mjs re-ran and
revalidated BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0 with a live probe.
Sonnet 5 catalog ids were probed and are AccessDenied on this account (would need separate
enablement — not needed; 4.5 is the working choice). Full end-to-end proof executed: POST
/chat through dev-server.mjs returned a real model reply ("Hey there! I'm Cafe Copilot...").
C1 is DONE with zero open items. Next: C2 — CockroachDB memory layer (conversations,
messages, notes, drafts, documents with CREATE VECTOR INDEX, persistence proven live).

## 2026-07-12 — C2 done: CockroachDB is the agent's memory, live-proven
memory/ workspace: schema (conversations/messages/notes/drafts/documents+VECTOR), migrate,
store (parameterized SQL, cosine <=> search — all three distance ops probed live, cosine
chosen to match normalized Titan v2 1024-dim embeddings from amazon.titan-embed-text-v2:0,
discovered+validated by agent/scripts/find-embedding-model.mjs). Handler persists turns and
replays last 12 as context; web keeps conversationId in localStorage. verify.mjs ALL PASS
against the live cluster; two-turn "remember my favourite pastry" proof recorded. 21/21
tests, lint/build clean. Note: businessId defaults to DEMO_BUSINESS_ID='demo-cafe' until the
seeded demo café exists (Codex track) — swap to the real seeded business id at integration.
Next: C4 (agent tools: live numbers via pos-sync summariser per Contract 1 — build against a
contract stub if Codex's C3 hasn't landed; search_memory; draft_purchase_order; real prompt).

## 2026-07-12 — Codex track reviewed and merged; timestamp ruling applied
Reviewed codex/work against merge-base: boundaries fully respected (only pos-sync/, demo-seed/,
ops/, STATUS-codex.md); prod-URL safety abort verified in code and in Codex's recorded test;
seed reconciliation clean (21/21 sessions, 0 mismatches). Merged into main (6da7177); 21/21
tests still green post-merge. Ruled on the contract question: NO backdating in production RPCs;
orchestrator-run staging fixup instead (see CONTRACTS.md Amendment 1) — applied and verified,
anomaly dates now correct. ccloud health probe: unit-tested only; real run deferred to C6/C7
(optional bonus; needs ccloud install + interactive auth by the owner). Demo business:
5065eeed-8968-4d41-b72b-f2293454addc "Harbour & Bean Demo Café" — C4 should use this as
DEMO_BUSINESS_ID.
