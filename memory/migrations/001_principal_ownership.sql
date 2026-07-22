-- Migration 001: Principal ownership for conversations, notes, drafts, and documents.
-- Idempotent schema evolution for CockroachDB.

-- 1. conversations: add principal columns, backfill, NOT NULL, CHECK constraint, and composite UNIQUE key
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS access_mode TEXT DEFAULT 'legacy_demo';

UPDATE conversations SET actor_id = 'legacy_demo' WHERE actor_id IS NULL OR actor_id = '';
UPDATE conversations SET access_mode = 'legacy_demo' WHERE access_mode IS NULL OR access_mode = '';

ALTER TABLE conversations ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN access_mode SET NOT NULL;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS chk_conversations_access_mode;
ALTER TABLE conversations ADD CONSTRAINT chk_conversations_access_mode CHECK (access_mode IN ('authenticated', 'demo', 'legacy_demo'));

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_id_business_actor_mode_key;
ALTER TABLE conversations ADD CONSTRAINT conversations_id_business_actor_mode_key UNIQUE (id, business_id, actor_id, access_mode);

CREATE INDEX IF NOT EXISTS conversations_principal_idx
  ON conversations (business_id, actor_id, access_mode, updated_at DESC);

-- 2. notes: add created_by, actor_id, access_mode
ALTER TABLE notes ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT 'legacy_demo';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS access_mode TEXT DEFAULT 'legacy_demo';

UPDATE notes SET created_by = 'legacy_demo' WHERE created_by IS NULL OR created_by = '';
ALTER TABLE notes ALTER COLUMN created_by SET NOT NULL;

CREATE INDEX IF NOT EXISTS notes_business_created_idx
  ON notes (business_id, created_at DESC);

-- 3. drafts: add principal columns, backfill, NOT NULL, CHECK, and composite foreign key
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS access_mode TEXT DEFAULT 'legacy_demo';

UPDATE drafts SET actor_id = 'legacy_demo' WHERE actor_id IS NULL OR actor_id = '';
UPDATE drafts SET access_mode = 'legacy_demo' WHERE access_mode IS NULL OR access_mode = '';

ALTER TABLE drafts ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE drafts ALTER COLUMN access_mode SET NOT NULL;

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS chk_drafts_access_mode;
ALTER TABLE drafts ADD CONSTRAINT chk_drafts_access_mode CHECK (access_mode IN ('authenticated', 'demo', 'legacy_demo'));

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_conversation_fk;
ALTER TABLE drafts ADD CONSTRAINT drafts_conversation_fk FOREIGN KEY (conversation_id, business_id, actor_id, access_mode) REFERENCES conversations (id, business_id, actor_id, access_mode) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS drafts_principal_idx
  ON drafts (business_id, actor_id, access_mode, created_at DESC);

-- 4. documents: add created_by and unique index for dated documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT 'system';
UPDATE documents SET created_by = 'system' WHERE created_by IS NULL OR created_by = '';
ALTER TABLE documents ALTER COLUMN created_by SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_business_type_date_key
  ON documents (business_id, doc_type, doc_date) WHERE doc_date IS NOT NULL;
