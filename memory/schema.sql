-- Café Copilot persistent memory schema (CockroachDB).
--
-- Idempotent: every statement is CREATE ... IF NOT EXISTS so this file can be re-applied
-- safely. `migrate.mjs` substitutes the __EMBEDDING_DIM__ placeholder below with the
-- EMBEDDING_DIM value from .env.local (set by agent/scripts/find-embedding-model.mjs)
-- before executing this file, since CockroachDB's VECTOR type is fixed-width per column.
--
-- Vector distance operator: CockroachDB (v25.4, verified live against the project cluster)
-- supports the pgvector-style operators <-> (L2), <=> (cosine), <#> (negative inner
-- product). We use <=> (cosine) in store.mjs's searchDocuments — Titan Text Embeddings v2
-- is called with `normalize: true` (see agent/embeddings.mjs), which makes cosine the
-- natural similarity measure for these vectors.

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at);

-- Durable business-context notes (used by C4's save_note tool).
CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Draft artifacts (purchase-order drafts, watch-lists, etc. — used by C4).
CREATE TABLE IF NOT EXISTS drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  conversation_id UUID REFERENCES conversations (id),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Embedded documents (daily POS summaries, menu, glossary — used by C3/C4's search_memory
-- tool). embedding is fixed-width VECTOR(__EMBEDDING_DIM__); see the substitution note above.
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_date DATE,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding VECTOR(__EMBEDDING_DIM__) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VECTOR INDEX IF NOT EXISTS documents_embedding_idx ON documents (embedding);
