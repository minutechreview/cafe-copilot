# Memory

CockroachDB is Café Copilot's persistent memory layer. This workspace owns the schema and
the only module in the codebase that talks SQL to it.

- `schema.sql` — idempotent (`CREATE ... IF NOT EXISTS`) schema for `conversations`,
  `messages`, `notes`, `drafts`, and `documents` (embedded, vector-indexed via
  `CREATE VECTOR INDEX`). The `embedding` column's width is a placeholder
  (`__EMBEDDING_DIM__`) substituted at migrate time from `EMBEDDING_DIM` in `.env.local`.
- `migrate.mjs` — applies `schema.sql` to `CRDB_CONNECTION_STRING`. Run with
  `npm run migrate --workspace=memory` (or `npm run memory:migrate` from the repo root).
- `store.mjs` — the CRUD/search API used by `agent/handler.mjs` and (from C3/C4) the
  agent's tools: `createConversation`, `appendMessage`, `getRecentMessages`, `saveNote`,
  `listNotes`, `saveDraft`, `upsertDocument`, `searchDocuments`.
- `verify.mjs` — live end-to-end proof against the real cluster (migrate → conversation
  round-trip → embed + upsert two documents via real Bedrock → vector search → clean up).
  Run with `npm run memory:verify` from the repo root.

Vector distance: CockroachDB (v25.4, verified live) supports the pgvector-style operators
`<->` (L2), `<=>` (cosine), and `<#>` (negative inner product). `store.mjs` uses `<=>`
(cosine) in `searchDocuments`, matching Titan Text Embeddings v2 called with
`normalize: true` in `agent/embeddings.mjs`.

See `docs/CONTRACTS.md` and the design contract for how this fits the rest of the agent.
