-- Approval-gated Copilot action lifecycle. CockroachDB holds only proposal and
-- passive-operation state; POS audit remains authoritative for POS execution.

CREATE TABLE IF NOT EXISTS copilot_action_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  action_key TEXT NOT NULL,
  action_version INT NOT NULL CHECK (action_version > 0),
  policy_version BIGINT NOT NULL CHECK (policy_version >= 0),
  normalized_payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  target_snapshot_hash TEXT,
  expected_state_hash TEXT,
  parent_action_id UUID,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'confirming', 'succeeded', 'rejected', 'expired', 'cancelled', 'stale', 'failed', 'reconciliation_pending')),
  confirmation_nonce_hash TEXT NOT NULL,
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  terminal_action_id UUID,
  terminal_code TEXT,
  terminal_message TEXT,
  terminal_result JSONB,
  reconciliation_state TEXT NOT NULL DEFAULT 'unobserved' CHECK (reconciliation_state IN ('unobserved', 'pending', 'observed')),
  reconciled_at TIMESTAMPTZ,
  pos_audit_action_id UUID,
  event_sequence INT NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT copilot_action_proposals_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT copilot_action_proposals_idempotency_key UNIQUE (business_id, actor_user_id, action_key, idempotency_key),
  CONSTRAINT copilot_action_proposals_terminal_action_key UNIQUE (business_id, terminal_action_id)
);

CREATE INDEX IF NOT EXISTS copilot_action_proposals_principal_status_idx
  ON copilot_action_proposals (business_id, actor_user_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS copilot_action_proposals_expiry_idx
  ON copilot_action_proposals (state, expires_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS copilot_action_confirm_limits (
  business_id UUID NOT NULL, actor_user_id UUID NOT NULL, window_started_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL CHECK (attempts >= 0 AND attempts <= 5),
  PRIMARY KEY (business_id, actor_user_id)
);

-- Events are append-only. Application code never updates/deletes these rows and
-- increments proposal.event_sequence in the same transaction as every event.
CREATE TABLE IF NOT EXISTS copilot_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL,
  business_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}',
  sequence INT NOT NULL CHECK (sequence > 0),
  CONSTRAINT copilot_action_events_proposal_fk FOREIGN KEY (business_id, proposal_id)
    REFERENCES copilot_action_proposals (business_id, id),
  CONSTRAINT copilot_action_events_sequence_key UNIQUE (business_id, proposal_id, sequence)
);

CREATE INDEX IF NOT EXISTS copilot_action_events_proposal_order_idx
  ON copilot_action_events (business_id, proposal_id, sequence);

-- An immutable observation is deliberately separate from the mutable proposal
-- projection. A POS success may be projected only with an authoritative audit id.
CREATE TABLE IF NOT EXISTS copilot_action_reconciliation_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL,
  business_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  observation TEXT NOT NULL CHECK (observation IN ('audit_succeeded', 'audit_failed', 'audit_absent', 'audit_unavailable', 'policy_mismatch')),
  action_id UUID,
  pos_audit_action_id UUID,
  result_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT copilot_action_reconciliation_proposal_fk FOREIGN KEY (business_id, proposal_id)
    REFERENCES copilot_action_proposals (business_id, id)
);

CREATE INDEX IF NOT EXISTS copilot_action_reconciliation_principal_idx
  ON copilot_action_reconciliation_observations (business_id, proposal_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS copilot_operational_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_action_id UUID NOT NULL,
  created_proposal_id UUID NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('reminder', 'handover', 'exception_note')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_kind TEXT,
  target_id UUID,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled', 'superseded')),
  version INT NOT NULL CHECK (version > 0),
  supersedes_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  completed_by UUID,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  CONSTRAINT copilot_operational_records_supersedes_fk FOREIGN KEY (supersedes_id)
    REFERENCES copilot_operational_records (id),
  CONSTRAINT copilot_operational_records_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT copilot_operational_records_action_key UNIQUE (business_id, created_action_id),
  CONSTRAINT copilot_operational_records_proposal_key UNIQUE (business_id, created_proposal_id)
);

CREATE INDEX IF NOT EXISTS copilot_operational_records_business_status_idx
  ON copilot_operational_records (business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS copilot_operational_record_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id UUID NOT NULL,
  business_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  action_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  command_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}',
  result_snapshot JSONB NOT NULL,
  CONSTRAINT copilot_operational_events_record_fk FOREIGN KEY (business_id, record_id)
    REFERENCES copilot_operational_records (business_id, id),
  CONSTRAINT copilot_operational_events_proposal_fk FOREIGN KEY (business_id, proposal_id)
    REFERENCES copilot_action_proposals (business_id, id),
  CONSTRAINT copilot_operational_events_action_key UNIQUE (business_id, action_id),
  CONSTRAINT copilot_operational_events_proposal_key UNIQUE (business_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS copilot_operational_events_history_idx
  ON copilot_operational_record_events (business_id, occurred_at DESC, action_id DESC);
