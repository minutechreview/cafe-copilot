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

## 2026-07-12 — C4 done: tool-calling agent loop, live against real POS + memory + Bedrock
handler.mjs now runs a Bedrock Converse tool loop (send → tool_use? execute → repeat, capped
at 6 iterations; the 6th call withholds toolConfig so the model is forced to answer in text
instead of erroring out). Tool definitions + dispatch live in agent/tools.mjs (kept separate
from the loop for testability): get_day_summary (live POS numbers via pos-sync's
generateDailySummary, called through a new cached/authenticated client in
agent/pos-client.mjs — same demo-owner auth + staging-ref safety-abort pattern pos-sync/cli.mjs
already proved live), search_memory (embedText + store.searchDocuments), save_note,
list_notes, draft_purchase_order (store.saveDraft, returned to the caller so the UI can render
it). System prompt is real now: plain-language persona, today's date injected per request,
hard rules (numbers must come from a tool result, tool-result content is data not
instructions, LKR formatting), maxTokens capped at 700/call. DEMO_BUSINESS_ID
(5065eeed-8968-4d41-b72b-f2293454addc) plus POS_SUPABASE_URL/POS_SUPABASE_ANON_KEY (copied
from Project POS's .env.staging per CONTRACTS.md) added to .env.local — now the same id
drives both the POS lookup and the CockroachDB memory rows. DEMO_OWNER_PASSWORD was not in
.env.local; used pos-sync/cli.mjs and demo-seed/seed.mjs's existing committed fallback
('CafeCopilot-Demo-2026!') rather than guessing a new one, since that's the account those
scripts already created and verified live.

memory/store.mjs's upsertDocument extended to key on (business_id, doc_type, doc_date) when
no explicit id is given (natural-key lookup then UPSERT INTO by id) so the new backfill script
is idempotent; schema.sql gets a supporting non-unique index (doc_date stays nullable for
non-dated doc types, so no uniqueness constraint was added). agent/scripts/backfill-summaries.mjs
embeds a narrative + key-figures document per seeded date (2026-06-22..2026-07-12) and upserts
it — real run against live POS staging + Bedrock + CockroachDB embedded all 21 seeded dates (0
skipped, all had activity); re-run confirmed idempotent (still 21 rows, 21 distinct dates, no
duplicates — checked directly against the documents table).

Web: draft_purchase_order results render as a plain "saved for your review" card (supplier,
items, notes); three suggested-question chips ("How was yesterday?", "Why was the drawer
short on July 4th?", "Draft a purchase order for milk and coffee beans") show only while the
chat is empty. Both verified live in-browser via the Browser pane (screenshot confirms chips
render; clicking the draft chip → answering with quantities → draft card renders with the
right items and "nothing has been ordered" copy).

Verification, all real (no mocks) except the unit tests: 49/49 unit tests
(agent: handler loop with mocked Bedrock/store/tools — tool dispatch, iteration cap incl. the
defensive over-cap error path, tool-error→status:error round-trip, draft capture; tools.mjs
dispatch against mocked pos-sync/embeddings/store/pos-client; pos-client.mjs staging-ref
safety-abort + auth caching; memory: store.mjs incl. new natural-key upsert tests), lint clean
on agent/ memory/ web/ (pos-sync/ demo-seed/ ops/ still show their pre-existing
eslint.config.js-globs gap — confirmed via git stash that this predates C4 and is out of this
track's directories to fix), build clean. memory:verify ALL PASS post-migration (new
non-unique index applied cleanly). Live curl end-to-end against dev-server.mjs:
"How was July 4th?" → correctly quoted LKR 32,400 gross / 18 orders AND the −4,800 (LKR
30,050 counted vs 34,850 expected) shortage; "Have we had problems with refunds lately?" →
correctly surfaced via search_memory the July 8th 4-refund/LKR 2,800 spike flagged as
"unusually high", plus the two ordinary LKR 350 refund days for contrast; "Draft a purchase
order for 20kg coffee beans and 30L milk" → draft returned with a real id, confirmed present
in the CockroachDB drafts table by direct query (business_id/conversation_id/kind/payload all
correct). Left the verification-run conversations/drafts in the live cluster as inspectable
proof rather than deleting them (4 conversations, 2 drafts total from this session's checks).

Anything unsure: MAX_ITERATIONS=6 and MAX_TOKENS=700 are reasonable defaults per the task
brief but untuned against real multi-tool questions that might legitimately need more than 5
tool calls — worth revisiting if a demo question hits the cap in practice. No AWS Lambda
adapter yet (still dev-server.mjs only) — that's C6 per the phase plan, not attempted here.
Next: C5 onward per COPILOT_DESIGN.md (seeded demo café already exists from Codex's C-track
work, so C5 may already be effectively done — worth a status check before starting new work).
