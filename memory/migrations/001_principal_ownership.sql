-- Migration 001: Principal ownership for conversations, notes, drafts, and documents.
-- Idempotent schema evolution for CockroachDB.

-- 1. conversations: add principal columns and backfill existing rows
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'legacy_demo';

UPDATE conversations SET access_mode = 'legacy_demo' WHERE access_mode IS NULL OR access_mode = '';

CREATE INDEX IF NOT EXISTS conversations_principal_idx
  ON conversations (business_id, actor_id, access_mode, updated_at DESC);

-- 2. notes: add created_by and principal columns
ALTER TABLE notes ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'legacy_demo';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS access_mode TEXT DEFAULT 'legacy_demo';

UPDATE notes SET created_by = 'legacy_demo' WHERE created_by IS NULL OR created_by = '';

CREATE INDEX IF NOT EXISTS notes_business_created_idx
  ON notes (business_id, created_at DESC);

-- 3. drafts: add principal columns and backfill
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'legacy_demo';

UPDATE drafts SET access_mode = 'legacy_demo' WHERE access_mode IS NULL OR access_mode = '';

CREATE INDEX IF NOT EXISTS drafts_principal_idx
  ON drafts (business_id, actor_id, access_mode, created_at DESC);

-- 4. documents: add created_by column
ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'system';
