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

## 2026-07-12 — C4 verified and merged by orchestrator
Independent verification on top of the builder's: 49/49 tests, build clean, and a fresh
unscripted question ("Which day last month had our biggest cash problem?") answered correctly
with real figures (July 4, −4,800, expected 34,850 vs counted 30,050) and baseline comparison.
Flag for C6/C7: the demo owner password has a committed fallback in pos-sync/demo-seed (Codex
track) — before the repo goes public, either rotate the staging demo account or explicitly
document it as intentional public demo credentials (RLS confines it to the demo business).
Remaining phases: C6 (Lambda deploy + public demo URL), C7 (submission kit). C5 done (Codex),
C3 done (Codex), C1/C2/C4 done (Claude track).

## 2026-07-13 — C4b (owner feedback): streaming + formatting, verified
Owner tested the live chat and asked for streamed replies, clean formatting (raw ** was
showing), and a future floating assistant inside the POS manager dashboard. First two are
DONE and orchestrator-verified (71/71 tests; live SSE curl shows incremental deltas with
correct figures; formatter is escape-before-transform, XSS-tested). The floating dashboard
assistant is APPROVED as a post-C6 step: it needs the public backend URL from the Lambda
deploy; plan is an embeddable widget in the POS dashboard (staging build, demo café) —
production embedding waits for per-business identity (Phase 12A territory). SSE heartbeat
note for C6: add keepalive comments for Lambda/proxy idle timeouts.

## 2026-07-13 — C6 partial: web half deployed, Lambda half BLOCKED on IAM permissions
Built the full Lambda path: agent/lambda.mjs wraps handler.mjs with awslambda.streamifyResponse
(RESPONSE_STREAM), lazily opens the SSE stream on first onEvent call so a synchronous
validation error still gets a real 400/500 (mirrors dev-server.mjs's contract exactly), adds
`: ping` heartbeat comment lines every 15s while a turn is in flight per the C4b note. 8 new
unit tests (agent/tests/lambda.test.mjs) cover request parsing, the happy SSE path, malformed
JSON, and both post-stream-start and pre-stream-start error paths, with `awslambda` stubbed
(it's a Lambda-runtime-only global — added as an eslint global for that one file, and
`dist-lambda/` added to eslint ignores + .gitignore since it's a generated bundle).
agent/scripts/bundle.mjs (esbuild, new devDependency) bundles lambda.mjs + everything it
imports (handler/tools/embeddings/pos-client + memory/store.mjs + pos-sync/summarizer.mjs,
read-only import per CONTRACTS.md) into a single 2.0MB ESM file, zipped with the system `zip`
CLI (no new JS dependency just for zipping); pg-native is the only external (pg's optional
native addon, not installed, required inside pg's own try/catch). Smoke-tested the actual
bundle output (not just the source) locally by stubbing the awslambda globals and running a
real "How was July 4th?" turn through it against live Bedrock + CockroachDB + POS staging —
correct streamed reply, correct figures, confirming the bundle itself (not just the
unbundled source) works before attempting any deploy.

agent/scripts/deploy-lambda.mjs (AWS SDK v3: client-iam, client-lambda, client-sts, all new
devDependencies) implements the full idempotent create-or-update sequence from the brief: IAM
role + inline policy (bedrock:InvokeModel*, logs:*, scoped to the function's own log group) →
wait for IAM propagation → Lambda function (nodejs22.x with nodejs20.x fallback, retrying
through role-not-yet-assumable errors) → PutFunctionConcurrency 5 → Function URL (AuthType
NONE, InvokeMode RESPONSE_STREAM, CORS for localhost:5173 + cafe-copilot.pages.dev, extra
origin via CLI arg for a second pass) → AddPermission for public Function URL invoke. Every
existence check uses Get-by-exact-name and branches on the not-found error, per the brief's
permission-shape warning — no List* calls anywhere in the script.

BLOCKED: running it against the real `cafe-copilot-dev` credentials in .env.local, every
single AWS call beyond sts:GetCallerIdentity is denied — not just IAM (iam:GetRole,
iam:CreateRole) but also plain Lambda reads (lambda:GetFunction, lambda:GetFunctionUrlConfig,
lambda:PutFunctionConcurrency), all with the same shape: "not authorized to perform: X on
resource: Y because no identity-based policy allows the X action." Retested iam:GetRole after
a 20s wait in case of propagation lag — same denial, so this isn't an eventual-consistency
issue. sts:GetCallerIdentity confirms the credentials are for the right user
(arn:aws:iam::606065959230:user/cafe-copilot-dev) and Bedrock calls through the exact same
credentials work fine (proven by the smoke test above), so this is specific to whatever
policy was meant to grant Lambda/IAM access — it does not appear to be attached, or doesn't
include these actions. Did not attempt to work around this (no privilege escalation, no
alternate credentials) — flagging for the owner to fix the `cafe-copilot-dev` policy (or
attach an existing one) before the Lambda half can be created. deploy-lambda.mjs itself is
untested against a live AWS account as a result; the logic has been reviewed carefully against
the brief but "runs cleanly end-to-end on first try" is NOT verified.

Web half deployed independently since it doesn't depend on the blocked AWS user: App.jsx now
reads `VITE_CHAT_URL` (falls back to '/chat' for the local dev proxy, unchanged default
behaviour — build/lint/test all still pass with no env var set). Cloudflare Pages project
`cafe-copilot` created and deployed via wrangler (already authenticated, confirmed `pages
(write)` scope) — live at https://cafe-copilot.pages.dev (200, title "Cafe Copilot"). This
deploy used the default build (VITE_CHAT_URL unset → relative '/chat') since no Function URL
exists yet, so the live chat UI currently has no backend to talk to — needs one more `npm run
build --workspace=web` + `wrangler pages deploy` once the Lambda half is unblocked and its
Function URL is known (see README's new Deployment section for the exact two commands).

Verification done: 79/79 unit tests (71 prior + 8 new lambda.test.mjs), lint clean on
agent/memory/web (dist-lambda/ added to eslint ignores; pos-sync/demo-seed/ops/ still show
their pre-existing gap, confirmed out of this track's directories), build clean. Pages URL
verified live over the public internet. Lambda Function URL, its SSE curl proof, and its CORS/
concurrency verification are all NOT done — blocked as described above.

Next: owner fixes the cafe-copilot-dev IAM policy (needs at minimum iam:GetRole,
iam:CreateRole, iam:PutRolePolicy scoped to role/cafe-copilot*, and
lambda:GetFunction/CreateFunction/UpdateFunctionCode/UpdateFunctionConfiguration/
GetFunctionConfiguration/PutFunctionConcurrency/GetFunctionUrlConfig/CreateFunctionUrlConfig/
UpdateFunctionUrlConfig/AddPermission scoped to function:cafe-copilot*) or pre-creates the
role/function by hand — then `npm run bundle --workspace=agent && npm run deploy-lambda
--workspace=agent` should complete the rest in one shot (idempotent, safe to retry), followed
by the two-command Pages redeploy with the real Function URL, then the full curl/CORS/
concurrency verification this phase couldn't reach.

## 2026-07-13 — C6 DONE: publicly deployed and verified; staff/waste tools added
Live: https://cafe-copilot.pages.dev (Cloudflare Pages) → streaming Lambda Function URL
(cadrhryuuiho5na3lqtwtwvqny0rhwzg...on.aws, RESPONSE_STREAM, CORS locked to the pages origin +
localhost). Execution role carries only bedrock:InvokeModel* + its own logs (no static keys in
Lambda). Two deployment landmines solved and baked into deploy-lambda.mjs: (1) new-account
concurrency quota makes reserved concurrency impossible — now best-effort with warning;
(2) since Oct 2025 public Function URLs need lambda:InvokeFunction in the resource policy in
addition to lambda:InvokeFunctionUrl — sole cause of persistent 403s (function itself proved
healthy via signed InvokeWithResponseStream). C6b (owner feedback): get_staff_performance +
get_waste_log tools live and publicly verified ("Ruwan Jayasinghe... LKR 90,550... 52 orders");
refunds attributed as approved-by, mirroring POS staff-report honesty. 86/86 tests. Remaining:
C7 (submission kit: public GitHub repo + license visibility check, video, tool docs, optional
diagram/feedback + optional ccloud probe wiring) and the post-C6 floating dashboard widget.
