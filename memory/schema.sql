-- Café Copilot persistent memory schema (CockroachDB).
--
-- Idempotent: every statement is CREATE ... IF NOT EXISTS so this file can be re-applied
-- safely. `migrate.mjs` substitutes the __EMBEDDING_DIM__ placeholder below with the
-- EMBEDDING_DIM value from .env.local (set by agent/scripts/find-embedding-model.mjs)
-- before executing this file, since CockroachDB's VECTOR type is fixed-width per column.

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  actor_id TEXT,
  access_mode TEXT NOT NULL DEFAULT 'legacy_demo' CHECK (access_mode IN ('authenticated', 'demo', 'legacy_demo')),
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_principal_idx
  ON conversations (business_id, actor_id, access_mode, updated_at DESC);

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
  created_by TEXT NOT NULL DEFAULT 'legacy_demo',
  actor_id TEXT,
  access_mode TEXT DEFAULT 'legacy_demo',
  content TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_business_created_idx
  ON notes (business_id, created_at DESC);

-- Draft artifacts (purchase-order drafts, watch-lists, etc. — used by C4).
CREATE TABLE IF NOT EXISTS drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  actor_id TEXT,
  access_mode TEXT NOT NULL DEFAULT 'legacy_demo' CHECK (access_mode IN ('authenticated', 'demo', 'legacy_demo')),
  conversation_id UUID REFERENCES conversations (id),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drafts_principal_idx
  ON drafts (business_id, actor_id, access_mode, created_at DESC);

-- Embedded documents (daily POS summaries, menu, glossary — used by C3/C4's search_memory
-- tool). embedding is fixed-width VECTOR(__EMBEDDING_DIM__); see the substitution note above.
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  doc_type TEXT NOT NULL,
  doc_date DATE,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding VECTOR(__EMBEDDING_DIM__) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VECTOR INDEX IF NOT EXISTS documents_embedding_idx ON documents (embedding);

CREATE INDEX IF NOT EXISTS documents_business_type_date_idx
  ON documents (business_id, doc_type, doc_date);
