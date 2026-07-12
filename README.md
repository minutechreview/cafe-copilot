# Café Copilot

A plain-language AI assistant for small café owners, built on the open-source Project POS.
Ask "How was today?", "Why was Tuesday's drawer short?", "Which items are wasting money?" —
get honest answers computed from your real till data, plus reviewable drafts (purchase
orders, items-to-watch lists). The copilot never writes to the POS.

Built for the CockroachDB × AWS AI Hackathon: CockroachDB is the agent's persistent memory
(conversations, business context, vector-indexed daily summaries); Amazon Bedrock runs the
model. See docs/CONTRACTS.md for architecture and build coordination.

Status: under construction. Design contract lives in the Project POS repo at
docs/hackathon/COPILOT_DESIGN.md until this repo is self-contained.

## Run it locally

Requires Node 20+ and npm.

1. Install dependencies from the repo root (npm workspaces cover `web/`, `agent/`, and
   `memory/`):
   ```
   npm install
   ```
2. Create `.env.local` at the repo root (gitignored — never commit it) with:
   - `CRDB_CONNECTION_STRING` — CockroachDB cluster connection string (agent memory)
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — AWS credentials with
     Bedrock access
   - `BEDROCK_MODEL_ID` — the Claude model id the agent calls; generate this automatically
     with `npm run find-model` (discovers the best available Sonnet model on your account
     and appends it for you), or set it by hand
   - `BEDROCK_EMBEDDING_MODEL_ID`, `EMBEDDING_DIM` — the embedding model used for vector
     search; generate both automatically with `npm run find-embedding-model`
3. Apply the CockroachDB schema (conversations, messages, notes, drafts, documents +
   vector index — idempotent, safe to re-run):
   ```
   npm run memory:migrate
   ```
4. Copy the POS staging connection details into the same `.env.local` (see
   `docs/CONTRACTS.md` for where these come from) and set the seeded demo business id:
   - `POS_SUPABASE_URL`, `POS_SUPABASE_ANON_KEY` — the POS staging project
     (`ljnzschozufepfpkzwjy`); the agent refuses to run against any other project ref
   - `DEMO_BUSINESS_ID` — the seeded demo café's business id, used for both the POS lookup
     (`get_day_summary`) and the CockroachDB memory rows (notes/drafts/documents)
   - `DEMO_OWNER_EMAIL` / `DEMO_OWNER_PASSWORD` — optional; default to the demo owner
     account `demo-seed/` and `pos-sync/` already created and use
5. Backfill the agent's memory with embedded daily summaries for the seeded date range, so
   `search_memory` has something to retrieve (idempotent — safe to re-run; re-embeds and
   updates existing rows instead of duplicating them):
   ```
   npm run agent:backfill
   ```
6. Start the backend and frontend in separate terminals:
   ```
   npm run dev:agent   # POST /chat on http://localhost:8787
   npm run dev:web     # chat UI on http://localhost:5173, proxies /chat to the agent
   ```
7. Open http://localhost:5173 and send a message. The conversation id is kept in
   `localStorage`, so reloading the page and asking "What did I just ask you?" continues
   the same conversation — CockroachDB, not the browser tab, is what remembers. Try one of
   the suggested-question chips, or ask about a specific day (e.g. "How was July 4th?") to
   see the agent call `get_day_summary` against live POS data.

Other useful commands from the repo root:
- `npm run lint`, `npm test` (agent + memory unit tests), `npm run build` (production web
  build)
- `npm run memory:verify` — live proof that the memory layer works: migrates, writes and
  reads back a conversation, embeds two texts via Bedrock, upserts them as vector-indexed
  documents, vector-searches with a third embedded query, and cleans up its own rows.
  Prints PASS/FAIL per step.
- `npm run agent:backfill` — embeds a daily-summary document (narrative + key figures) for
  every date in the seeded demo café's history and upserts it into CockroachDB memory.
