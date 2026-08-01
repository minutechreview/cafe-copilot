import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const queryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();
const PoolMock = vi.fn().mockImplementation(() => ({ query: queryMock, connect: connectMock, end: vi.fn() }));

vi.mock('pg', () => ({ default: { Pool: PoolMock } }));

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_ID = '44444444-4444-4444-8444-444444444444';
const ACTION_ID = '55555555-5555-4555-8555-555555555555';
const AUDIT_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ACTOR_ID = '99999999-9999-4999-8999-999999999999';
const NORMALIZED_PAYLOAD = { targetId: 'safe' };
const HASH = createHash('sha256').update(JSON.stringify(NORMALIZED_PAYLOAD)).digest('hex');
const OTHER_HASH = 'b'.repeat(64);
const PRINCIPAL = { businessId: BUSINESS_ID, actorId: ACTOR_ID, accessMode: 'authenticated' };
const payloadHash = (payload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const proposalInput = (overrides = {}) => ({
  id: PROPOSAL_ID, actionKey: 'menu.availability.set', actionVersion: 1, policyVersion: 7,
  normalizedPayload: NORMALIZED_PAYLOAD, payloadHash: HASH, confirmationNonceHash: OTHER_HASH,
  idempotencyKey: 'server-request-1', expiresAt: new Date(Date.now() + 60_000), ...overrides,
});

function proposedRow(overrides = {}) {
  return {
    id: PROPOSAL_ID, business_id: BUSINESS_ID, actor_user_id: ACTOR_ID,
    action_key: 'menu.availability.set', action_version: 1, policy_version: 7,
    normalized_payload: NORMALIZED_PAYLOAD, payload_hash: HASH, state: 'proposed',
    event_sequence: 1, expires_at: new Date(Date.now() + 60_000), ...overrides,
  };
}

describe('approval-gated action memory', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset(); clientQueryMock.mockReset(); releaseMock.mockReset(); connectMock.mockReset(); PoolMock.mockClear();
    connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    process.env.CRDB_CONNECTION_STRING = 'postgresql://test:test@localhost:26257/test';
  });

  it('blocks demo/legacy principals before any query and requires UUID-bound authenticated scope', async () => {
    const store = await import('../store.mjs');
    await expect(store.createActionProposal({ ...PRINCIPAL, accessMode: 'demo' }, {})).rejects.toThrow(/authenticated principal/);
    await expect(store.getActionProposal({ ...PRINCIPAL, actorId: 'not-a-uuid' }, PROPOSAL_ID)).rejects.toThrow(/canonical UUID/);
    expect(connectMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('creates a proposal and immutable first event atomically without storing a raw nonce', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { createActionProposal } = await import('../store.mjs');
    const result = await createActionProposal(PRINCIPAL, {
      id: PROPOSAL_ID, actionKey: 'menu.availability.set', actionVersion: 1, policyVersion: 7,
      normalizedPayload: NORMALIZED_PAYLOAD, payloadHash: HASH, confirmationNonceHash: OTHER_HASH,
      idempotencyKey: 'server-request-1', expiresAt: new Date(Date.now() + 60_000),
    });
    expect(result.created).toBe(true);
    expect(clientQueryMock).toHaveBeenNthCalledWith(1, 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const [insertSql, params] = clientQueryMock.mock.calls[1];
    expect(insertSql).toContain('ON CONFLICT (business_id, actor_user_id, action_key, idempotency_key)');
    expect(params).toContain(OTHER_HASH);
    expect(JSON.stringify(params)).not.toContain('raw-confirmation-nonce');
    expect(clientQueryMock.mock.calls[2][0]).toContain('copilot_action_events');
    expect(clientQueryMock).toHaveBeenLastCalledWith('COMMIT');
  });

  it('returns only an identical principal-scoped proposal for an idempotent retry', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposedRow()] })
      .mockResolvedValueOnce(undefined);
    const { createActionProposal } = await import('../store.mjs');
    const result = await createActionProposal(PRINCIPAL, {
      id: PROPOSAL_ID, actionKey: 'menu.availability.set', actionVersion: 1, policyVersion: 7,
      normalizedPayload: NORMALIZED_PAYLOAD, payloadHash: HASH, confirmationNonceHash: OTHER_HASH,
      idempotencyKey: 'server-request-1', expiresAt: new Date(Date.now() + 60_000),
    });
    expect(result.created).toBe(false);
    expect(clientQueryMock.mock.calls[2][0]).toContain('actor_user_id = $2');
    expect(clientQueryMock.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('copilot_action_events'))).toHaveLength(0);
  });

  it('creates or rotates an exact live proposal nonce in one transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposedRow({ event_sequence: 2 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { createOrRotateActionProposal } = await import('../store.mjs');
    const result = await createOrRotateActionProposal(PRINCIPAL, proposalInput());
    expect(result).toMatchObject({ created: false, nonceBound: true, proposal: { id: PROPOSAL_ID } });
    const [sql, params] = clientQueryMock.mock.calls[2];
    expect(sql).toContain("state = 'proposed' AND expires_at > now()");
    expect(sql).toContain('payload_hash = $5 AND action_version = $6 AND policy_version = $8');
    expect(params).toEqual([BUSINESS_ID, ACTOR_ID, 'menu.availability.set', 'server-request-1', HASH, 1, OTHER_HASH, 7]);
    expect(clientQueryMock.mock.calls[3][0]).toContain('confirmation_nonce_rotated');
    expect(JSON.stringify(clientQueryMock.mock.calls[3][1])).not.toContain(OTHER_HASH);
  });

  it('fails closed when an idempotent proposal retry mismatches or is no longer live', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { createOrRotateActionProposal } = await import('../store.mjs');
    await expect(createOrRotateActionProposal(PRINCIPAL, proposalInput()))
      .rejects.toThrow(/conflicts, expired, or is no longer proposed/);
    expect(clientQueryMock).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('retries a concurrent serialization conflict before rotating the same proposal', async () => {
    const serializationError = Object.assign(new Error('concurrent retry'), { code: '40001' });
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(serializationError)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposedRow({ event_sequence: 2 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { createOrRotateActionProposal } = await import('../store.mjs');
    await expect(createOrRotateActionProposal(PRINCIPAL, proposalInput()))
      .resolves.toMatchObject({ created: false, nonceBound: true });
    expect(clientQueryMock.mock.calls.filter(([sql]) => String(sql).startsWith('BEGIN TRANSACTION'))).toHaveLength(2);
  });

  it('does not bind another actor to an existing proposal id or expose its row', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate proposal id'), { code: '23505' });
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(uniqueViolation)
      .mockResolvedValueOnce(undefined);
    const { createOrRotateActionProposal } = await import('../store.mjs');
    const otherPrincipal = { ...PRINCIPAL, actorId: OTHER_ACTOR_ID };
    await expect(createOrRotateActionProposal(otherPrincipal, proposalInput())).rejects.toBe(uniqueViolation);
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('confirmation_nonce_rotated'))).toBe(false);
    expect(clientQueryMock).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('atomically claims a nonce-bound proposal, rotates its hash, and appends the next ordered event', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ state: 'confirming', lease_id: LEASE_ID, event_sequence: 2 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { claimActionProposal } = await import('../store.mjs');
    await claimActionProposal(PRINCIPAL, {
      proposalId: PROPOSAL_ID, leaseId: LEASE_ID, confirmationNonceHash: HASH, rotatedNonceHash: OTHER_HASH, expectedPolicyVersion: 7,
    });
    const [sql, params] = clientQueryMock.mock.calls[1];
    expect(sql).toContain("state = 'proposed'");
    expect(sql).toContain('confirmation_nonce_hash = $7');
    expect(params).toEqual([PROPOSAL_ID, BUSINESS_ID, ACTOR_ID, HASH, LEASE_ID, 60, OTHER_HASH, 7]);
    expect(clientQueryMock.mock.calls[2][1]).toContain(2);
  });

  it('does not allow CRDB to claim POS success without authoritative audit evidence', async () => {
    const { recordActionTerminal } = await import('../store.mjs');
    await expect(recordActionTerminal(PRINCIPAL, {
      proposalId: PROPOSAL_ID, leaseId: LEASE_ID, state: 'succeeded', code: 'OK', actionId: ACTION_ID,
    })).rejects.toThrow(/authoritative POS audit/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('scopes status lookup to the exact actor and business, so another manager cannot recover a proposal', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { getActionProposal } = await import('../store.mjs');
    await expect(getActionProposal(PRINCIPAL, PROPOSAL_ID)).resolves.toBeNull();
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('business_id = $2 AND actor_user_id = $3');
    expect(params).toEqual([PROPOSAL_ID, BUSINESS_ID, ACTOR_ID]);
  });

  it('looks up operational record state only inside the authenticated business', async () => {
    const recordId = '77777777-7777-4777-8777-777777777777';
    queryMock.mockResolvedValueOnce({ rows: [{ id: recordId, business_id: BUSINESS_ID, status: 'open', version: '4' }] });
    const { getOperationalRecord } = await import('../store.mjs');
    await expect(getOperationalRecord(PRINCIPAL, recordId)).resolves.toMatchObject({ id: recordId, status: 'open', version: 4 });
    expect(queryMock.mock.calls[0][0]).toContain('WHERE id = $1 AND business_id = $2');
    expect(queryMock.mock.calls[0][1]).toEqual([recordId, BUSINESS_ID]);
  });

  it('rejects unsafe Cockroach INT operational versions instead of losing precision', async () => {
    const recordId = '77777777-7777-4777-8777-777777777777';
    queryMock.mockResolvedValueOnce({ rows: [{ id: recordId, business_id: BUSINESS_ID, status: 'open', version: '9007199254740992' }] });
    const { getOperationalRecord } = await import('../store.mjs');
    await expect(getOperationalRecord(PRINCIPAL, recordId)).rejects.toThrow(/safe positive integer/);
  });

  it('discovers only minimal tenant-scoped operational records with safe versions', async () => {
    const recordId = '77777777-7777-4777-8777-777777777777';
    queryMock.mockResolvedValueOnce({ rows: [{
      id: recordId, record_type: 'reminder', title: 'Count milk', status: 'open', version: '12',
      business_id: BUSINESS_ID,
      body: 'must never be returned',
    }] });
    const { findOperationalRecords } = await import('../store.mjs');
    const rows = await findOperationalRecords(PRINCIPAL, { query: 'milk' });
    expect(rows).toEqual([{
      id: recordId, businessId: BUSINESS_ID, recordType: 'reminder', title: 'Count milk', status: 'open', version: 12,
    }]);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('WHERE business_id = $1');
    expect(sql).toContain('SELECT id, business_id, record_type');
    expect(sql).toContain('title ILIKE $3');
    expect(sql).not.toContain('body');
    expect(params).toEqual([BUSINESS_ID, ['open'], '%milk%', 10]);
  });

  it('escapes wildcard input rather than allowing a broader ILIKE search', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { findOperationalRecords } = await import('../store.mjs');
    await findOperationalRecords(PRINCIPAL, { query: String.raw`100%_done\later`, statuses: ['open', 'cancelled'], limit: 3 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("ESCAPE '\\'");
    expect(params[2]).toBe(String.raw`%100\%\_done\\later%`);
    expect(sql).not.toContain('100%_done');
  });

  it('rejects unsupported discovery statuses, limits, and non-authenticated principals before SQL', async () => {
    const { findOperationalRecords } = await import('../store.mjs');
    await expect(findOperationalRecords(PRINCIPAL, { query: 'milk', statuses: ['deleted'] })).rejects.toThrow(/unsupported/);
    await expect(findOperationalRecords(PRINCIPAL, { query: 'milk', limit: 11 })).rejects.toThrow('limit must be 1..10');
    await expect(findOperationalRecords({ ...PRINCIPAL, accessMode: 'demo' }, { query: 'milk' })).rejects.toThrow(/authenticated/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('an old nonce digest cannot claim after rotation', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { claimActionProposal } = await import('../store.mjs');
    await expect(claimActionProposal(PRINCIPAL, {
      proposalId: PROPOSAL_ID, leaseId: LEASE_ID, confirmationNonceHash: HASH,
      rotatedNonceHash: 'c'.repeat(64), expectedPolicyVersion: 7,
    })).rejects.toThrow(/unavailable, expired, or already claimed/);
    expect(clientQueryMock.mock.calls[1][0]).toContain('confirmation_nonce_hash = $4');
    expect(clientQueryMock.mock.calls[1][1][3]).toBe(HASH);
    expect(clientQueryMock).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('recovers an expired confirmation lease only as reconciliation_pending and never re-executes it', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ state: 'reconciliation_pending', event_sequence: 3 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { recoverExpiredActionLease } = await import('../store.mjs');
    const result = await recoverExpiredActionLease(PRINCIPAL, PROPOSAL_ID);
    expect(result.state).toBe('reconciliation_pending');
    expect(clientQueryMock.mock.calls[1][0]).toContain("state = 'reconciliation_pending'");
    expect(clientQueryMock.mock.calls[2][0]).toContain('lease_expired_reconciliation_pending');
  });

  it('projects audit success only through an authoritative reconciliation observation', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ state: 'reconciliation_pending', lease_expires_at: new Date(Date.now() - 1_000) })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposedRow({ state: 'succeeded', event_sequence: 4, pos_audit_action_id: AUDIT_ID })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { recordActionReconciliation } = await import('../store.mjs');
    const result = await recordActionReconciliation(PRINCIPAL, {
      proposalId: PROPOSAL_ID, observation: 'audit_succeeded', authoritativeAudit: true, actionId: ACTION_ID,
      posAuditActionId: AUDIT_ID, resultCode: 'OK', metadata: { source: 'actor-status-read' },
    });
    expect(result.state).toBe('succeeded');
    expect(clientQueryMock.mock.calls[2][0]).toContain('copilot_action_reconciliation_observations');
    expect(clientQueryMock.mock.calls[3][0]).toContain("state IN ('confirming', 'reconciliation_pending')");
    expect(clientQueryMock.mock.calls[3][0]).toContain('(lease_expires_at <= now() OR $9)');
    expect(clientQueryMock.mock.calls[3][1][5]).toBe(ACTION_ID);
    expect(clientQueryMock.mock.calls[3][1][6]).toBe(AUDIT_ID);
  });

  it('allows authoritative committed POS success to repair an active confirmation lease', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ state: 'confirming', lease_id: LEASE_ID, lease_expires_at: new Date(Date.now() + 60_000) })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposedRow({ state: 'succeeded', event_sequence: 3, terminal_action_id: ACTION_ID, pos_audit_action_id: AUDIT_ID })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { recordActionReconciliation } = await import('../store.mjs');
    await expect(recordActionReconciliation(PRINCIPAL, {
      proposalId: PROPOSAL_ID, observation: 'audit_succeeded', authoritativeAudit: true,
      actionId: ACTION_ID, posAuditActionId: AUDIT_ID, resultCode: 'OK', metadata: { source: 'status_rpc' },
    })).resolves.toMatchObject({ state: 'succeeded', terminalActionId: ACTION_ID, posAuditActionId: AUDIT_ID });
    expect(clientQueryMock.mock.calls[3][0]).toContain('(lease_expires_at <= now() OR $9)');
    expect(clientQueryMock.mock.calls[3][1][8]).toBe(true);
  });

  it('contains every operational transition within the claimed proposal transaction', async () => {
    const recordId = '77777777-7777-4777-8777-777777777777';
    const persistedPayload = { body: 'Before 4pm', recordType: 'reminder', title: 'Count milk', verb: 'create' };
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ action_key: 'ops.reminder.create', normalized_payload: persistedPayload, payload_hash: payloadHash(persistedPayload) })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ event_sequence: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: recordId, business_id: BUSINESS_ID, record_type: 'reminder', title: 'Count milk', body: 'Before 4pm', status: 'open', version: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposedRow({ action_key: 'ops.reminder.create', state: 'succeeded', terminal_action_id: ACTION_ID, event_sequence: 3 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { claimAndExecuteOperationalRecordCommand } = await import('../store.mjs');
    const result = await claimAndExecuteOperationalRecordCommand(PRINCIPAL, {
      proposalId: PROPOSAL_ID, actionId: ACTION_ID, confirmationNonceHash: HASH,
      rotatedNonceHash: OTHER_HASH, expectedPolicyVersion: 7,
      title: 'CALLER MUST NOT WIN',
    });
    expect(result.result.record.status).toBe('open');
    expect(result.result.record.title).toBe('Count milk');
    const sql = clientQueryMock.mock.calls.map(([text]) => String(text)).join('\n');
    expect(sql).toContain('copilot_operational_records');
    expect(sql).toContain('copilot_operational_record_events');
    expect(sql).toContain("terminal_code = 'OK'");
    expect(clientQueryMock).toHaveBeenLastCalledWith('COMMIT');
  });

  it('requires persisted recordType and verb to agree with the proposal action key', async () => {
    const mismatchedPayload = { body: 'Before 4pm', recordType: 'handover', title: 'Count milk', verb: 'create' };
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ action_key: 'ops.reminder.create', normalized_payload: mismatchedPayload, payload_hash: payloadHash(mismatchedPayload) })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { claimAndExecuteOperationalRecordCommand } = await import('../store.mjs');
    await expect(claimAndExecuteOperationalRecordCommand(PRINCIPAL, {
      proposalId: PROPOSAL_ID, actionId: ACTION_ID, confirmationNonceHash: HASH,
      rotatedNonceHash: OTHER_HASH, expectedPolicyVersion: 7,
    })).rejects.toThrow(/recordType\/verb does not match/);
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes("SET state = 'confirming'"))).toBe(false);
    expect(clientQueryMock).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('uses the record version and open state for a passive completion rather than overwriting a changed record', async () => {
    const recordId = '77777777-7777-4777-8777-777777777777';
    const persistedPayload = { expectedVersion: 1, recordId, recordType: 'handover', verb: 'complete' };
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ action_key: 'ops.handover.complete', normalized_payload: persistedPayload, payload_hash: payloadHash(persistedPayload) })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ event_sequence: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: recordId, business_id: BUSINESS_ID, record_type: 'handover', title: 'Close', body: 'Tell night crew', status: 'completed', version: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [proposedRow({ action_key: 'ops.handover.complete', state: 'succeeded', terminal_action_id: ACTION_ID, event_sequence: 3 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { claimAndExecuteOperationalRecordCommand } = await import('../store.mjs');
    const result = await claimAndExecuteOperationalRecordCommand(PRINCIPAL, {
      proposalId: PROPOSAL_ID, actionId: ACTION_ID, confirmationNonceHash: HASH,
      rotatedNonceHash: OTHER_HASH, expectedPolicyVersion: 7,
    });
    expect(result.result.record.status).toBe('completed');
    const transition = clientQueryMock.mock.calls[5];
    expect(transition[0]).toContain("status = 'open' AND version = $6");
    expect(transition[1]).toContain(1);
  });

  it('rejects recursively normalized secret keys while allowing ordinary metadata vocabulary', async () => {
    const store = await import('../store.mjs');
    const secretPayloads = [
      { nested: [{ manager_pin: '1234' }] },
      { accessToken: 'token' },
      { Authorization: 'Bearer x' },
      { account_password: 'secret' },
      { capabilityEnvelope: 'opaque' },
    ];
    for (const normalizedPayload of secretPayloads) {
      await expect(store.createActionProposal(PRINCIPAL, {
        actionKey: 'menu.availability.set', actionVersion: 1, policyVersion: 7,
        normalizedPayload, payloadHash: 'c'.repeat(64), confirmationNonceHash: OTHER_HASH,
        idempotencyKey: 'secret-test', expiresAt: new Date(Date.now() + 60_000),
      })).rejects.toThrow(/authentication|secret|capability|PIN|nonce/);
    }
    expect(connectMock).not.toHaveBeenCalled();

    const safePayload = { metadata: { authorizationModel: 'rbac', passwordPolicy: 'strong' }, title: 'Safe' };
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ normalized_payload: safePayload, payload_hash: store.hashCanonicalPayload(safePayload) })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    await expect(store.createActionProposal(PRINCIPAL, {
      id: PROPOSAL_ID, actionKey: 'menu.availability.set', actionVersion: 1, policyVersion: 7,
      normalizedPayload: safePayload, payloadHash: store.hashCanonicalPayload(safePayload), confirmationNonceHash: OTHER_HASH,
      idempotencyKey: 'safe-metadata', expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toMatchObject({ created: true });
  });

  it('never lets reconciliation observations alter an active confirmation lease', async () => {
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ state: 'confirming', lease_id: LEASE_ID, lease_expires_at: new Date(Date.now() + 60_000) })] })
      .mockResolvedValueOnce(undefined);
    const { recordActionReconciliation } = await import('../store.mjs');
    await expect(recordActionReconciliation(PRINCIPAL, {
      proposalId: PROPOSAL_ID, observation: 'audit_unavailable', metadata: {},
    })).rejects.toThrow(/Active confirmation lease/);
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO copilot_action_reconciliation_observations'))).toBe(false);
    expect(clientQueryMock).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('replays the immutable supersede terminal snapshot with the new record id', async () => {
    const oldRecordId = '77777777-7777-4777-8777-777777777777';
    const newRecordId = '88888888-8888-4888-8888-888888888888';
    const snapshot = {
      schemaVersion: 1, proposalId: PROPOSAL_ID, actionId: ACTION_ID,
      action: 'ops.exception_note.supersede', status: 'succeeded', code: 'OK',
      result: { record: { id: newRecordId, status: 'open' }, supersededRecordId: oldRecordId },
    };
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ action_key: 'ops.exception_note.supersede', state: 'succeeded' })] })
      .mockResolvedValueOnce({ rows: [{ result_snapshot: snapshot }] })
      .mockResolvedValueOnce(undefined);
    const { claimAndExecuteOperationalRecordCommand } = await import('../store.mjs');
    const replay = await claimAndExecuteOperationalRecordCommand(PRINCIPAL, {
      proposalId: PROPOSAL_ID, actionId: ACTION_ID, confirmationNonceHash: HASH,
      rotatedNonceHash: OTHER_HASH, expectedPolicyVersion: 7,
    });
    expect(replay.result.record.id).toBe(newRecordId);
    expect(replay.result.supersededRecordId).toBe(oldRecordId);
    expect(replay.replayed).toBe(true);
    expect(clientQueryMock.mock.calls.some(([sql]) => /^(INSERT|UPDATE)\b/.test(String(sql).trim()))).toBe(false);
  });

  it('uses the full occurredAt/sourceRank/actionId cursor tuple for merged history inputs', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { listOperationalActionHistory } = await import('../store.mjs');
    const timestamp = '2026-08-01T12:00:00.000Z';
    await listOperationalActionHistory(PRINCIPAL, {
      asOf: timestamp, beforeOccurredAt: timestamp, beforeSourceRank: 1, beforeActionId: ACTION_ID, limit: 25,
    });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('0 < $4 OR (0 = $4 AND e.action_id < $5)');
    expect(sql).toContain('ORDER BY e.occurred_at DESC, source_rank DESC, e.action_id DESC');
    expect(params).toEqual([BUSINESS_ID, timestamp, timestamp, 1, ACTION_ID, 25]);
  });

  it('renders passive history from the immutable event snapshot without joining current record state', async () => {
    const recordId = '77777777-7777-4777-8777-777777777777';
    const snapshot = {
      schemaVersion: 1, proposalId: PROPOSAL_ID, actionId: ACTION_ID,
      action: 'ops.reminder.create', status: 'succeeded', code: 'OK',
      result: { record: { id: recordId, status: 'open', version: 1 }, supersededRecordId: null },
    };
    queryMock.mockResolvedValueOnce({ rows: [{
      action_id: ACTION_ID, proposal_id: PROPOSAL_ID, command_key: 'ops.reminder.create',
      occurred_at: new Date(), metadata: {}, source_rank: 0, result_snapshot: JSON.stringify(snapshot),
    }] });
    const { listOperationalActionHistory } = await import('../store.mjs');
    const history = await listOperationalActionHistory(PRINCIPAL, { limit: 1 });
    expect(history[0].record).toEqual(snapshot.result.record);
    expect(history[0].resultSnapshot).toEqual(snapshot);
    expect(queryMock.mock.calls[0][0]).toContain('e.result_snapshot');
    expect(queryMock.mock.calls[0][0]).not.toContain('JOIN copilot_operational_records');
  });

  it('retries Cockroach serialization failures with a bounded, deterministic policy', async () => {
    const serializationError = Object.assign(new Error('restart transaction'), { code: '40001' });
    clientQueryMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(serializationError)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [proposedRow({ state: 'cancelled', event_sequence: 2 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const { cancelActionProposal, transactionRetryDelayMs, MAX_TRANSACTION_RETRIES } = await import('../store.mjs');
    await expect(cancelActionProposal(PRINCIPAL, PROPOSAL_ID)).resolves.toMatchObject({ state: 'cancelled' });
    expect(clientQueryMock.mock.calls.filter(([sql]) => String(sql).startsWith('BEGIN TRANSACTION'))).toHaveLength(2);
    expect(clientQueryMock.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(MAX_TRANSACTION_RETRIES).toBe(3);
    expect([1, 2, 3].map(transactionRetryDelayMs)).toEqual([0, 5, 20]);
  });

  it('stops after the bounded serialization retry count and honors aborts during retry', async () => {
    const serializationError = Object.assign(new Error('restart transaction'), { code: '40001' });
    clientQueryMock.mockImplementation((sql) => {
      if (String(sql).includes("SET state = 'cancelled'")) return Promise.reject(serializationError);
      return Promise.resolve(undefined);
    });
    const { cancelActionProposal, MAX_TRANSACTION_RETRIES } = await import('../store.mjs');
    await expect(cancelActionProposal(PRINCIPAL, PROPOSAL_ID)).rejects.toBe(serializationError);
    expect(clientQueryMock.mock.calls.filter(([sql]) => String(sql).startsWith('BEGIN TRANSACTION')))
      .toHaveLength(MAX_TRANSACTION_RETRIES + 1);

    clientQueryMock.mockReset();
    const controller = new AbortController();
    clientQueryMock.mockImplementation((sql) => {
      if (String(sql).includes("SET state = 'cancelled'")) {
        controller.abort();
        return Promise.reject(serializationError);
      }
      return Promise.resolve(undefined);
    });
    await expect(cancelActionProposal(PRINCIPAL, PROPOSAL_ID, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(releaseMock).toHaveBeenCalledWith(true);
    expect(clientQueryMock.mock.calls.filter(([sql]) => String(sql).startsWith('BEGIN TRANSACTION'))).toHaveLength(1);
  });
});
