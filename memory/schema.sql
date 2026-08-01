-- Café Copilot persistent memory schema (CockroachDB).
--
-- Idempotent: every statement is CREATE ... IF NOT EXISTS so this file can be re-applied
-- safely. `migrate.mjs` substitutes the __EMBEDDING_DIM__ placeholder below with the
-- EMBEDDING_DIM value from .env.local (set by agent/scripts/find-embedding-model.mjs)
-- before executing this file, since CockroachDB's VECTOR type is fixed-width per column.

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT 'legacy_demo',
  access_mode TEXT NOT NULL DEFAULT 'legacy_demo' CHECK (access_mode IN ('authenticated', 'demo', 'legacy_demo')),
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversations_id_business_actor_mode_key UNIQUE (id, business_id, actor_id, access_mode)
);

CREATE INDEX IF NOT EXISTS conversations_principal_idx
  ON conversations (business_id, actor_id, access_mode, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at);

-- Durable business-context notes (used by C4's save_note tool). Business-shared.
CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'legacy_demo',
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
  actor_id TEXT NOT NULL DEFAULT 'legacy_demo',
  access_mode TEXT NOT NULL DEFAULT 'legacy_demo' CHECK (access_mode IN ('authenticated', 'demo', 'legacy_demo')),
  conversation_id UUID,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drafts_conversation_fk FOREIGN KEY (conversation_id, business_id, actor_id, access_mode) REFERENCES conversations (id, business_id, actor_id, access_mode) ON DELETE CASCADE
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

CREATE UNIQUE INDEX IF NOT EXISTS documents_business_type_date_key
  ON documents (business_id, doc_type, doc_date) WHERE doc_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_business_type_date_idx
  ON documents (business_id, doc_type, doc_date);

-- Approval-gated action lifecycle and passive operational records. These tables
-- duplicate migration 002 for clean installs; the migration remains additive for
-- existing installations. They contain no POS success claim or secret material.
CREATE TABLE IF NOT EXISTS copilot_action_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID NOT NULL, actor_user_id UUID NOT NULL,
  action_key TEXT NOT NULL, action_version INT NOT NULL CHECK (action_version > 0), policy_version BIGINT NOT NULL CHECK (policy_version >= 0),
  normalized_payload JSONB NOT NULL, payload_hash TEXT NOT NULL, target_snapshot_hash TEXT, expected_state_hash TEXT, parent_action_id UUID,
  idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('proposed','confirming','succeeded','rejected','expired','cancelled','stale','failed','reconciliation_pending')),
  confirmation_nonce_hash TEXT NOT NULL, lease_id UUID, lease_expires_at TIMESTAMPTZ, terminal_action_id UUID, terminal_code TEXT, terminal_message TEXT, terminal_result JSONB,
  reconciliation_state TEXT NOT NULL DEFAULT 'unobserved' CHECK (reconciliation_state IN ('unobserved','pending','observed')),
  reconciled_at TIMESTAMPTZ, pos_audit_action_id UUID, event_sequence INT NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT copilot_action_proposals_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT copilot_action_proposals_idempotency_key UNIQUE (business_id, actor_user_id, action_key, idempotency_key),
  CONSTRAINT copilot_action_proposals_terminal_action_key UNIQUE (business_id, terminal_action_id)
);
CREATE INDEX IF NOT EXISTS copilot_action_proposals_principal_status_idx ON copilot_action_proposals (business_id, actor_user_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS copilot_action_proposals_expiry_idx ON copilot_action_proposals (state, expires_at, lease_expires_at);
CREATE TABLE IF NOT EXISTS copilot_action_confirm_limits (
  business_id UUID NOT NULL, actor_user_id UUID NOT NULL, window_started_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL CHECK (attempts >= 0 AND attempts <= 5), PRIMARY KEY (business_id, actor_user_id)
);

CREATE TABLE IF NOT EXISTS copilot_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id UUID NOT NULL, business_id UUID NOT NULL, actor_user_id UUID NOT NULL,
  event_type TEXT NOT NULL, event_at TIMESTAMPTZ NOT NULL DEFAULT now(), metadata JSONB NOT NULL DEFAULT '{}', sequence INT NOT NULL CHECK (sequence > 0),
  CONSTRAINT copilot_action_events_proposal_fk FOREIGN KEY (business_id, proposal_id) REFERENCES copilot_action_proposals (business_id, id),
  CONSTRAINT copilot_action_events_sequence_key UNIQUE (business_id, proposal_id, sequence)
);
CREATE INDEX IF NOT EXISTS copilot_action_events_proposal_order_idx ON copilot_action_events (business_id, proposal_id, sequence);

CREATE TABLE IF NOT EXISTS copilot_action_reconciliation_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id UUID NOT NULL, business_id UUID NOT NULL, actor_user_id UUID NOT NULL,
  observation TEXT NOT NULL CHECK (observation IN ('audit_succeeded','audit_failed','audit_absent','audit_unavailable','policy_mismatch')),
  action_id UUID, pos_audit_action_id UUID, result_code TEXT, metadata JSONB NOT NULL DEFAULT '{}', observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT copilot_action_reconciliation_proposal_fk FOREIGN KEY (business_id, proposal_id) REFERENCES copilot_action_proposals (business_id, id)
);
CREATE INDEX IF NOT EXISTS copilot_action_reconciliation_principal_idx ON copilot_action_reconciliation_observations (business_id, proposal_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS copilot_operational_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID NOT NULL, created_by UUID NOT NULL, created_action_id UUID NOT NULL, created_proposal_id UUID NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('reminder','handover','exception_note')), title TEXT NOT NULL, body TEXT NOT NULL,
  target_kind TEXT, target_id UUID, due_at TIMESTAMPTZ, status TEXT NOT NULL CHECK (status IN ('open','completed','cancelled','superseded')),
  version INT NOT NULL CHECK (version > 0), supersedes_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, completed_by UUID,
  cancelled_at TIMESTAMPTZ, cancelled_by UUID,
  CONSTRAINT copilot_operational_records_supersedes_fk FOREIGN KEY (supersedes_id) REFERENCES copilot_operational_records (id),
  CONSTRAINT copilot_operational_records_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT copilot_operational_records_action_key UNIQUE (business_id, created_action_id),
  CONSTRAINT copilot_operational_records_proposal_key UNIQUE (business_id, created_proposal_id)
);
CREATE INDEX IF NOT EXISTS copilot_operational_records_business_status_idx ON copilot_operational_records (business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS copilot_operational_record_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), record_id UUID NOT NULL, business_id UUID NOT NULL, proposal_id UUID NOT NULL, action_id UUID NOT NULL,
  actor_user_id UUID NOT NULL, command_key TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), metadata JSONB NOT NULL DEFAULT '{}', result_snapshot JSONB NOT NULL,
  CONSTRAINT copilot_operational_events_record_fk FOREIGN KEY (business_id, record_id) REFERENCES copilot_operational_records (business_id, id),
  CONSTRAINT copilot_operational_events_proposal_fk FOREIGN KEY (business_id, proposal_id) REFERENCES copilot_action_proposals (business_id, id),
  CONSTRAINT copilot_operational_events_action_key UNIQUE (business_id, action_id),
  CONSTRAINT copilot_operational_events_proposal_key UNIQUE (business_id, proposal_id)
);
CREATE INDEX IF NOT EXISTS copilot_operational_events_history_idx ON copilot_operational_record_events (business_id, occurred_at DESC, action_id DESC);
