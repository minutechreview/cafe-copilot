import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveAuthContextMock = vi.fn();
vi.mock('../auth-context.mjs', () => ({ resolveAuthContext: resolveAuthContextMock }));

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';

function proposal(overrides = {}) {
  return {
    id: PROPOSAL_ID,
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_ID,
    actionKey: 'menu.price.set',
    actionVersion: 1,
    policyVersion: 7,
    payloadHash: 'a'.repeat(64),
    parentActionId: null,
    state: 'proposed',
    expiresAt: '2026-08-01T12:05:00.000Z',
    ...overrides,
  };
}

function store(current = proposal()) {
  return {
    getActionProposalForActor: vi.fn(async () => current),
    getActionProposal: vi.fn(async () => current),
    claimActionProposal: vi.fn(async () => ({ ...current, state: 'confirming' })),
    recordActionTerminal: vi.fn(async (_principal, input) => ({ ...current, state: input.state, terminalActionId: input.actionId ?? null, terminalCode: input.code, terminalMessage: input.message ?? null, terminalResult: input.terminalResult ?? null })),
    releaseActionProposalAfterRejection: vi.fn(async () => ({ ...current, state: 'proposed' })),
  };
}

function confirmBody(overrides = {}) {
  return { proposalId: PROPOSAL_ID, confirmationNonce: 'one-time-nonce', confirm: true, ...overrides };
}

function dependencies(overrides = {}) {
  return {
    proposalStore: store(),
    resolvePolicy: vi.fn(async () => ({ globalEnabled: true, businessEnabled: true, actionEnabled: true, version: 7 })),
    confirmLimiter: vi.fn(async () => ({ allowed: true })),
    executor: vi.fn(async ({ actionId }) => ({ status: 'failed', code: 'TARGET_CHANGED', actionId })),
    capabilitySigner: vi.fn(() => 'opaque-server-capability'),
    ...overrides,
  };
}

beforeEach(() => {
  resolveAuthContextMock.mockReset();
  resolveAuthContextMock.mockResolvedValue({ mode: 'authenticated', businessId: BUSINESS_ID, userId: ACTOR_ID, accessToken: 'verified-jwt' });
});

describe('approved action HTTP transport', () => {
  it('fails closed before claim when the policy resolver is unavailable', async () => {
    const { handleActionHttpRequest } = await import('../actions/http.mjs');
    const deps = dependencies({ resolvePolicy: undefined });
    const response = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: { authorization: 'Bearer untrusted-browser-token' }, body: confirmBody() }, { dependencies: deps });
    expect(response).toMatchObject({ status: 503, body: { code: 'ACTION_DISABLED' } });
    expect(deps.proposalStore.claimActionProposal).not.toHaveBeenCalled();
    expect(deps.executor).not.toHaveBeenCalled();
  });

  it('fails closed before claim when the durable confirmation limiter is unavailable', async () => {
    const { handleActionHttpRequest } = await import('../actions/http.mjs');
    const deps = dependencies({ confirmLimiter: undefined });
    const response = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: {}, body: confirmBody() }, { dependencies: deps });
    expect(response).toMatchObject({ status: 503, body: { code: 'ACTION_DISABLED' } });
    expect(deps.proposalStore.claimActionProposal).not.toHaveBeenCalled();
  });

  it('fails closed before claim when no trusted POS executor is composed', async () => {
    const { handleActionHttpRequest } = await import('../actions/http.mjs');
    const deps = dependencies({ executor: undefined });
    const response = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: {}, body: confirmBody() }, { dependencies: deps });
    expect(response).toMatchObject({ status: 503, body: { code: 'ACTION_DISABLED' } });
    expect(deps.proposalStore.claimActionProposal).not.toHaveBeenCalled();
  });

  it('uses the widget-shaped body and derives tenant only from its actor-bound proposal', async () => {
    const { handleActionHttpRequest } = await import('../actions/http.mjs');
    const deps = dependencies();
    const response = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: { authorization: 'Bearer browser-token' }, body: confirmBody({ managerPin: '4821' }) }, { dependencies: deps });

    expect(resolveAuthContextMock).toHaveBeenCalledWith(
      { headers: { authorization: 'Bearer browser-token' }, mode: 'authenticated' },
      { signal: undefined, allowUnscopedAuthenticatedActor: true }
    );
    expect(deps.proposalStore.getActionProposalForActor).toHaveBeenCalledWith(ACTOR_ID, PROPOSAL_ID, { signal: undefined });
    expect(deps.proposalStore.getActionProposal).toHaveBeenCalledWith(expect.objectContaining({ businessId: BUSINESS_ID, actorId: ACTOR_ID }), PROPOSAL_ID, { signal: undefined });
    expect(deps.executor).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({ businessId: BUSINESS_ID, actorId: ACTOR_ID }),
      managerPin: '4821',
      capability: 'opaque-server-capability',
    }));
    expect(JSON.stringify(response.body)).not.toContain('4821');
    expect(JSON.stringify(response.body)).not.toContain('opaque-server-capability');
  });

  it('never accepts PIN/capability fields outside confirmation and never replays a terminal proposal', async () => {
    const { handleActionHttpRequest } = await import('../actions/http.mjs');
    const deps = dependencies({ proposalStore: store(proposal({ state: 'succeeded', terminalActionId: PROPOSAL_ID, terminalCode: 'OK' })) });
    const terminal = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: {}, body: confirmBody() }, { dependencies: deps });
    expect(terminal).toMatchObject({ status: 200, body: { status: 'succeeded', code: 'OK' } });
    expect(deps.executor).not.toHaveBeenCalled();

    const invalidUndo = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/undo', headers: {}, body: { proposalId: PROPOSAL_ID, managerPin: '4821' } }, { dependencies: deps });
    expect(invalidUndo).toMatchObject({ status: 400, body: { code: 'INVALID_ACTION_REQUEST' } });
  });

  it('returns reconciliation_pending, never success, after an ambiguous executor outcome', async () => {
    const { handleActionHttpRequest } = await import('../actions/http.mjs');
    const deps = dependencies({ executor: vi.fn(async () => { throw new Error('network timeout'); }) });
    const response = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: {}, body: confirmBody() }, { dependencies: deps });
    expect(response).toMatchObject({ status: 200, body: { status: 'reconciliation_pending', code: 'EXECUTION_AMBIGUOUS' } });
    expect(deps.proposalStore.recordActionTerminal).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ state: 'reconciliation_pending' }), { signal: undefined });
  });

  it('persists and replays the exact terminal result, undo and completedAt', async () => {
    const { handleActionHttpRequest } = await import('../actions/http.mjs');
    const completedAt = '2026-08-01T12:01:02.000Z';
    const outcome = {
      status: 'succeeded', code: 'OK', actionId: PROPOSAL_ID, posAuditActionId: PROPOSAL_ID,
      authoritativePosAudit: true, completedAt,
      result: { targetId: PROPOSAL_ID, targetRevision: 18 },
      undo: { supported: true, eligibleUntil: '2026-08-01T12:16:02.000Z' },
    };
    const firstStore = store();
    const first = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: {}, body: confirmBody() }, { dependencies: dependencies({ proposalStore: firstStore, executor: vi.fn(async () => outcome) }) });
    const replayedProposal = (await firstStore.recordActionTerminal.mock.results[0].value);
    const replay = await handleActionHttpRequest({ method: 'POST', path: '/copilot/actions/confirm', headers: {}, body: confirmBody() }, { dependencies: dependencies({ proposalStore: store(replayedProposal) }) });
    expect(replay.body).toEqual(first.body);
    expect(replay.body).toMatchObject({ completedAt, result: outcome.result, undo: outcome.undo });
  });
});
