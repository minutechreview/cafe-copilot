import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveAuthContext } = vi.hoisted(() => ({ resolveAuthContext: vi.fn() }));
vi.mock('../auth-context.mjs', () => ({ resolveAuthContext }));

import { handleActionHttpRequest } from '../actions/http.mjs';
import { createConfiguredActionDependencies, UNDO_RPC } from '../actions/runtime.mjs';

const BUSINESS = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
const ACTION = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const ENV = { COPILOT_ACTIONS_RUNTIME_ENABLED: 'true', COPILOT_CAPABILITY_HMAC_KEY: 'secret', COPILOT_CAPABILITY_KID: 'kid', CRDB_CONNECTION_STRING: 'postgresql://configured' };

function proposed(actionKey = 'menu.price.set') {
  return { id: PROPOSAL, businessId: BUSINESS, actorUserId: ACTOR, actionKey, state: 'proposed', policyVersion: 7, payloadHash: HASH, normalizedPayload: { targetId: ACTION, price: '1.250', expectedRevision: 1 } };
}

function configured({ store = {}, rpc = vi.fn() } = {}) {
  const posClient = { rpc };
  return { deps: createConfiguredActionDependencies({ env: ENV, store, createPosClient: vi.fn(async () => posClient) }), posClient };
}

beforeEach(() => {
  resolveAuthContext.mockReset();
  resolveAuthContext.mockImplementation(async (input) => input.businessId
    ? { mode: 'authenticated', businessId: BUSINESS, userId: ACTOR, accessToken: 'jwt' }
    : { mode: 'authenticated', userId: ACTOR, accessToken: 'jwt' });
});

describe('configured approved-action runtime', () => {
  it('accepts exactly one fully validated policy RPC row', async () => {
    for (const data of [[], [{ global_enabled: true, business_enabled: true, action_enabled: true, policy_version: 7 }, { global_enabled: true, business_enabled: true, action_enabled: true, policy_version: 7 }], [{ global_enabled: true, business_enabled: true, action_enabled: true, policy_version: 'unsafe' }]]) {
      const { deps } = configured({ rpc: vi.fn(async () => ({ data, error: null })) });
      expect(await deps.resolvePolicy({ businessId: BUSINESS, action: 'menu.price.set', posClient: { rpc: vi.fn(async () => ({ data, error: null })) } })).toBeNull();
    }
    const row = { global_enabled: true, business_enabled: true, action_enabled: true, policy_version: 7 };
    const { deps } = configured();
    await expect(deps.resolvePolicy({ businessId: BUSINESS, action: 'menu.price.set', posClient: { rpc: vi.fn(async () => ({ data: [row], error: null })) } })).resolves.toMatchObject({ version: 7 });
  });

  it('maps only the fixed POS PIN error to retryable rejection and throws on transport ambiguity', async () => {
    const { deps } = configured();
    const proposal = proposed();
    await expect(deps.executor({ proposal, actionId: ACTION, capability: 'cap', managerPin: '1111', posClient: { rpc: vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'PIN_NOT_ACCEPTED' } })) } })).resolves.toEqual({ status: 'rejected', code: 'PIN_REJECTED', actionId: null });
    await expect(deps.executor({ proposal, actionId: ACTION, capability: 'cap', managerPin: '1111', posClient: { rpc: vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'TARGET_CHANGED' } })) } })).resolves.toMatchObject({ status: 'failed', code: 'TARGET_CHANGED' });
  });

  it('persists an authoritative forward projection that exposes a bounded undo descriptor', async () => {
    const completedAt = '2026-08-01T12:00:00.000Z';
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ status: 'succeeded', result_code: 'OK', action_id: ACTION, target_id: PROPOSAL, target_revision: 2, completed_at: completedAt }], error: null })
      .mockResolvedValueOnce({ data: [{ proposal_id: PROPOSAL, status: 'succeeded', result_code: 'OK', action_id: ACTION, target_id: PROPOSAL, target_revision: 2, completed_at: completedAt }], error: null });
    const { deps } = configured();
    const outcome = await deps.executor({ proposal: proposed(), actionId: ACTION, capability: 'cap', managerPin: '1234', posClient: { rpc } });
    expect(outcome).toMatchObject({ authoritativePosAudit: true, result: { targetId: PROPOSAL, targetRevision: 2 }, undo: { supported: true, conditions: [] } });
    expect(outcome.undo).not.toHaveProperty('actionId');
    expect(Date.parse(outcome.undo.eligibleUntil) - Date.parse(completedAt)).toBe(5 * 60_000);
    expect(rpc).toHaveBeenLastCalledWith('copilot_get_action_audit_status', { p_business_id: BUSINESS, p_proposal_id: PROPOSAL });
  });

  it('honors an authoritative eligible_until only within the exact five-minute boundary', async () => {
    const completedAt = '2026-08-01T12:00:00.000Z';
    const result = { status: 'succeeded', result_code: 'OK', action_id: ACTION, target_id: PROPOSAL, target_revision: 2, completed_at: completedAt };
    const { deps } = configured();
    const validAudit = { ...result, proposal_id: PROPOSAL, eligible_until: '2026-08-01T12:04:00.000Z' };
    const validRpc = vi.fn().mockResolvedValueOnce({ data: [result], error: null }).mockResolvedValueOnce({ data: [validAudit], error: null });
    await expect(deps.executor({ proposal: proposed(), actionId: ACTION, capability: 'cap', managerPin: '1234', posClient: { rpc: validRpc } })).resolves.toMatchObject({ undo: { eligibleUntil: validAudit.eligible_until } });
    const invalidAudit = { ...validAudit, eligible_until: '2026-08-01T12:05:00.001Z' };
    const invalidRpc = vi.fn().mockResolvedValueOnce({ data: [result], error: null }).mockResolvedValueOnce({ data: [invalidAudit], error: null });
    await expect(deps.executor({ proposal: proposed(), actionId: ACTION, capability: 'cap', managerPin: '1234', posClient: { rpc: invalidRpc } })).rejects.toThrow('audit detail');
  });

  it('dispatches ops confirmations to the configured atomic operational executor without POS claiming', async () => {
    const proposal = proposed('ops.reminder.complete');
    const store = {
      getActionProposalForActor: vi.fn(async () => proposal), getActionProposal: vi.fn(async () => proposal),
      consumeActionConfirmLimit: vi.fn(async () => ({ allowed: true })), claimActionProposal: vi.fn(), recordActionTerminal: vi.fn(),
      claimAndExecuteOperationalRecordCommand: vi.fn(async () => ({ proposal: { ...proposal, state: 'succeeded', terminalActionId: ACTION, terminalCode: 'OK' } })),
    };
    const rpc = vi.fn(async (name) => name === 'copilot_get_action_policy' ? { data: [{ global_enabled: true, business_enabled: true, action_enabled: true, policy_version: 7 }], error: null } : { data: [], error: null });
    const { deps } = configured({ store, rpc });
    const response = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: { authorization: 'Bearer jwt' }, body: { proposalId: PROPOSAL, confirmationNonce: 'nonce', confirm: true } }, { dependencies: deps });
    expect(response.body).toMatchObject({ status: 'succeeded', action: 'ops.reminder.complete' });
    expect(store.claimAndExecuteOperationalRecordCommand).toHaveBeenCalledOnce();
    expect(store.claimActionProposal).not.toHaveBeenCalled();
  });

  it('wires actor-scoped reconciliation, merged history, undo preparation and a closed undo registry', async () => {
    const proposal = { ...proposed(), state: 'reconciliation_pending', terminalActionId: ACTION };
    const store = {
      recordActionReconciliation: vi.fn(async () => ({ ...proposal, state: 'succeeded', terminalCode: 'OK' })),
      listOperationalActionHistory: vi.fn(async () => [{ source: 'passive', sourceRank: 0, actionId: PROPOSAL, proposalId: PROPOSAL, commandKey: 'ops.reminder.create', occurredAt: '2026-08-01T11:00:00Z', resultSnapshot: { status: 'succeeded', code: 'OK' } }]),
      getActionProposal: vi.fn(async () => ({ ...proposal, state: 'succeeded', actionKey: 'menu.price.set' })),
      prepareActionUndoProposal: vi.fn(async (_principal, input) => ({ proposal: { action: input.proposalId === PROPOSAL ? 'menu.price.undo' : null } })),
    };
    const { deps } = configured({ store });
    const auditCompletedAt = new Date(Date.now() - 30_000).toISOString();
    const auditEligibleUntil = new Date(Date.now() + 60_000).toISOString();
    const audit = { action_id: ACTION, proposal_id: PROPOSAL, action_key: 'menu.price.set', target_kind: 'menu_item', target_id: PROPOSAL, before_state: { price: '1.000' }, after_state: { price: '1.250' }, before_revision: 1, after_revision: 2, status: 'succeeded', result_code: 'OK', completed_at: auditCompletedAt, eligible_until: auditEligibleUntil };
    const posClient = { rpc: vi.fn(async (name) => name === 'copilot_list_action_audit' ? { data: [{ ...audit, action_key: 'menu.price.set' }], error: null } : { data: [audit], error: null }) };
    await expect(deps.reconcile({ principal: { businessId: BUSINESS, actorId: ACTOR }, proposal, posClient })).resolves.toMatchObject({ state: 'succeeded' });
    expect(store.recordActionReconciliation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ authoritativeAudit: true, proposalId: PROPOSAL, terminalResult: expect.objectContaining({ result: expect.any(Object), undo: expect.objectContaining({ supported: true, conditions: [] }) }) }), expect.anything());
    const history = await deps.history({ principal: { businessId: BUSINESS, actorId: ACTOR }, posClient, limit: 10 });
    expect(history.items.map((item) => item.source)).toEqual(['pos', 'passive']);
    await expect(deps.prepareUndo({ principal: { businessId: BUSINESS, actorId: ACTOR }, proposalId: PROPOSAL, posClient })).resolves.toMatchObject({ proposal: { action: 'menu.price.undo' } });
    expect(store.prepareActionUndoProposal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ auditUndo: expect.objectContaining({ payloadSnapshot: { targetId: PROPOSAL, restorePrice: '1.000', expectedRevision: 2, parentActionId: ACTION } }) }), {});
    expect(posClient.rpc).toHaveBeenCalledWith('copilot_get_action_audit_detail', { p_business_id: BUSINESS, p_action_id: ACTION });
    expect(Object.keys(UNDO_RPC)).toEqual(expect.arrayContaining(['menu.price.undo', 'waste.reverse', 'cash.paid_in_out.reverse']));
  });

  it('reconciles a lost success response into a replay-compatible persisted terminal envelope', async () => {
    const completedAt = '2026-08-01T12:00:00.000Z';
    let current = { ...proposed(), state: 'reconciliation_pending' };
    const store = {
      getActionProposalForActor: vi.fn(async () => current),
      getActionProposal: vi.fn(async () => current),
      recordActionReconciliation: vi.fn(async (_principal, input) => {
        current = { ...current, state: 'succeeded', terminalActionId: input.actionId, posAuditActionId: input.posAuditActionId, terminalCode: input.resultCode, terminalResult: input.terminalResult };
        return current;
      }),
    };
    const audit = { proposal_id: PROPOSAL, action_id: ACTION, status: 'succeeded', result_code: 'OK', target_id: PROPOSAL, target_revision: 2, completed_at: completedAt };
    const { deps } = configured({ store, rpc: vi.fn(async () => ({ data: [audit], error: null })) });
    const request = { method: 'GET', path: `/copilot/actions/${PROPOSAL}`, headers: { authorization: 'Bearer jwt' }, query: {} };
    const reconciled = await handleActionHttpRequest(request, { dependencies: deps });
    expect(reconciled.body).toMatchObject({ status: 'succeeded', code: 'OK', result: { targetId: PROPOSAL, targetRevision: 2 }, undo: { supported: true, conditions: [] } });
    expect(Date.parse(reconciled.body.undo.eligibleUntil) - Date.parse(completedAt)).toBe(5 * 60_000);
    const replay = await handleActionHttpRequest(request, { dependencies: deps });
    expect(replay.body).toEqual(reconciled.body);
    expect(store.recordActionReconciliation).toHaveBeenCalledOnce();
  });

  it('executes a closed undo RPC and separates deterministic denial from transport ambiguity', async () => {
    const { deps } = configured();
    const undo = { ...proposed('menu.price.undo'), normalizedPayload: { targetId: PROPOSAL, restorePrice: '1.000', expectedRevision: 2, parentActionId: ACTION } };
    const deterministic = { rpc: vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'TARGET_CHANGED' } })) };
    await expect(deps.executor({ proposal: undo, actionId: ACTION, capability: 'cap', managerPin: '1234', posClient: deterministic })).resolves.toMatchObject({ status: 'failed', code: 'TARGET_CHANGED' });
    expect(deterministic.rpc).toHaveBeenCalledWith('copilot_undo_menu_price', expect.objectContaining({ p_parent_action_id: ACTION, p_restore_price: '1.000' }));
    await expect(deps.executor({ proposal: undo, actionId: ACTION, capability: 'cap', managerPin: '1234', posClient: { rpc: vi.fn(async () => { throw new Error('socket reset'); }) } })).rejects.toThrow('socket reset');
    await expect(deps.executor({ proposal: undo, actionId: ACTION, capability: 'cap', managerPin: '1234', posClient: { rpc: vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'SOME_NEW_ERROR' } })) } })).rejects.toThrow('transport');
  });

  it('rejects tampered, cross-action, and expired authoritative undo detail', async () => {
    const store = { getActionProposal: vi.fn(async () => ({ ...proposed(), state: 'succeeded', terminalActionId: ACTION, actionKey: 'menu.price.set' })), prepareActionUndoProposal: vi.fn() };
    const { deps } = configured({ store });
    const base = { action_id: ACTION, action_key: 'menu.price.set', target_kind: 'menu_item', target_id: PROPOSAL, before_state: { price: '1.000' }, after_state: { price: '1.250' }, after_revision: 2, status: 'succeeded', result_code: 'OK' };
    for (const row of [{ ...base, action_key: 'stock.count.correct', eligible_until: new Date(Date.now() + 60_000).toISOString() }, { ...base, eligible_until: new Date(Date.now() - 1_000).toISOString() }, { ...base, before_state: { price: 1 }, eligible_until: new Date(Date.now() + 60_000).toISOString() }]) {
      const posClient = { rpc: vi.fn(async () => ({ data: [row], error: null })) };
      await expect(deps.prepareUndo({ principal: { businessId: BUSINESS, actorId: ACTOR }, proposalId: PROPOSAL, posClient })).resolves.toBeNull();
    }
    expect(store.prepareActionUndoProposal).not.toHaveBeenCalled();
  });
});
