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

1. Install dependencies from the repo root (npm workspaces cover `web/` and `agent/`):
   ```
   npm install
   ```
2. Create `.env.local` at the repo root (gitignored — never commit it) with:
   - `CRDB_CONNECTION_STRING` — CockroachDB cluster connection string (agent memory, used
     from C2 onward)
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — AWS credentials with
     Bedrock access
   - `BEDROCK_MODEL_ID` — the Claude model id the agent calls; generate this automatically
     with `npm run find-model` (discovers the best available Sonnet model on your account
     and appends it for you), or set it by hand
3. Start the backend and frontend in separate terminals:
   ```
   npm run dev:agent   # POST /chat on http://localhost:8787
   npm run dev:web     # chat UI on http://localhost:5173, proxies /chat to the agent
   ```
4. Open http://localhost:5173 and send a message.

Other useful commands from the repo root: `npm run lint`, `npm test` (agent unit tests),
`npm run build` (production web build).
