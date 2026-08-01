import { describe, expect, it } from 'vitest';
import {
  ACTION_REGISTRY,
  ActionValidationError,
  canonicalSha256,
  canonicalizeJcs,
  decodeBase64url,
  encodeActionPayload,
  getActionModelInputSchema,
  prepareActionProposal,
  signCapability,
  verifyCapability,
} from '../actions/index.mjs';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';

function row(data) {
  const builder = {
    select: () => builder, eq: () => builder, in: () => builder, order: () => builder,
    maybeSingle: async () => ({ data, error: null }), then: (resolve, reject) => Promise.resolve({ data: Array.isArray(data) ? data : [data], error: null }).then(resolve, reject),
  };
  return builder;
}
function posClient() {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      if (table === 'businesses') return row({ id: BUSINESS_ID, currency: 'KWD' });
      if (table === 'menu_items') return row({ id: ITEM_ID, revision: 7, name: 'Cappuccino', price: '1.250', currency: 'KWD', available: true });
      throw new Error(`unexpected table ${table}`);
    },
  };
}
function authenticatedCtx(overrides = {}) {
  return {
    conversationId: 'conversation-1',
    principal: { businessId: BUSINESS_ID, actorId: ACTOR_ID, accessMode: 'authenticated' },
    posClient: posClient(),
    actionPolicy: { globalEnabled: true, businessEnabled: true, actionEnabled: true, version: 4 },
    actionDependencies: { proposalLimiter: { consume: async () => ({ allowed: true }) } },
    ...overrides,
  };
}

describe('approved action registry', () => {
  it('is closed and each model tool has an explicit closed input schema', () => {
    expect(Object.keys(ACTION_REGISTRY)).toContain('menu.price.set');
    expect(Object.keys(ACTION_REGISTRY)).not.toContain('sql.execute');
    const schema = getActionModelInputSchema('menu.price.set');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['targetId', 'price']);
    expect(() => getActionModelInputSchema('https.post')).toThrow(ActionValidationError);
  });

  it('rejects unknown payload fields and validates exact KWD decimals', () => {
    expect(() => encodeActionPayload('menu.price.set', { targetId: ITEM_ID, expectedRevision: 7, price: '1.25', extra: 'no' }, { currency: 'KWD' })).toThrow('unknown field');
    expect(() => encodeActionPayload('menu.price.set', { targetId: ITEM_ID, expectedRevision: 7, price: '1.25' }, { currency: 'KWD' })).toThrow('exact 3-decimal');
    expect(encodeActionPayload('menu.price.set', { targetId: ITEM_ID, expectedRevision: 7, price: '1.250' }, { currency: 'KWD' })).toEqual({ targetKind: 'menu_item', targetId: ITEM_ID, expectedRevision: 7, price: '1.250', currency: 'KWD' });
  });

  it('uses canonical payload hashes independent of object key order', () => {
    expect(canonicalSha256({ b: ['x', 0], a: 'é' })).toBe(canonicalSha256({ a: 'é', b: ['x', -0] }));
  });

  it('matches JCS number vectors and rejects lone surrogates/noncanonical base64url', () => {
    expect(canonicalizeJcs([333333333.33333329, 1E30, 4.50, 2e-3, 1e-27])).toBe('[333333333.3333333,1e+30,4.5,0.002,1e-27]');
    expect(() => canonicalizeJcs('\ud800')).toThrow('lone surrogates');
    expect(() => canonicalizeJcs({ '\udc00': true })).toThrow('lone surrogates');
    expect(() => decodeBase64url('AB')).toThrow('canonical');
  });

  it('denies a demo before policy or POS access', async () => {
    const client = posClient();
    await expect(prepareActionProposal({ action: 'menu.price.set', input: { targetId: ITEM_ID, price: '1.250' }, ctx: authenticatedCtx({ principal: { businessId: BUSINESS_ID, actorId: 'demo-session', accessMode: 'demo' }, posClient: client }) })).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    expect(client.calls).toEqual([]);
  });

  it('defaults policy off before target lookup', async () => {
    const client = posClient();
    await expect(prepareActionProposal({ action: 'menu.price.set', input: { targetId: ITEM_ID, price: '1.250' }, ctx: authenticatedCtx({ posClient: client, actionPolicy: undefined }) })).rejects.toMatchObject({ code: 'ACTION_DISABLED' });
    expect(client.calls).toEqual([]);
  });

  it('resolves targets through explicit caller-scoped business filters and emits a proposal only', async () => {
    const client = posClient();
    const saved = [];
    const result = await prepareActionProposal({
      action: 'menu.price.set', input: { targetId: ITEM_ID, price: '1.250' }, ctx: authenticatedCtx({ posClient: client }),
      store: { createActionProposal: async (_principal, input) => { saved.push(input); return { created: true, proposal: { id: PROPOSAL_ID, expiresAt: input.expiresAt } }; } },
      operationId: 'tool-use-1',
      now: new Date('2026-08-01T12:00:00.000Z'), random: () => Buffer.alloc(32, 7),
    });
    expect(client.calls).toEqual(['businesses', 'menu_items']);
    expect(saved).toHaveLength(1);
    expect(saved[0].normalizedPayload.expectedRevision).toBe(7);
    expect(saved[0].normalizedPayload).not.toHaveProperty('capability');
    expect(result.proposal).toMatchObject({ id: PROPOSAL_ID, action: 'menu.price.set', confirmationNonce: expect.any(String) });
    expect(JSON.stringify(result.proposal)).not.toContain('COPILOT_CAPABILITY_HMAC_KEY');
  });

  it('creates a bounded JCS HMAC capability only for a trusted executor and never includes a secret claim', () => {
    const token = signCapability({ kid: 'test-key', actionId: PROPOSAL_ID, proposalId: PROPOSAL_ID, parentActionId: null, action: 'menu.price.set', businessId: BUSINESS_ID, actorUserId: ACTOR_ID, payloadHash: 'a'.repeat(64), policyVersion: 4 }, { key: Buffer.alloc(32, 9), now: new Date('2026-08-01T12:00:00.000Z') });
    expect(token.split('.')).toHaveLength(2);
    expect(token).not.toContain('secret');
    expect(verifyCapability(token, { key: Buffer.alloc(32, 9), allowedKids: ['test-key'], now: new Date('2026-08-01T12:00:01.000Z') })).toMatchObject({ action: 'menu.price.set' });
    const [body, signature] = token.split('.');
    const tampered = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}.${signature}`;
    expect(() => verifyCapability(tampered, { key: Buffer.alloc(32, 9), allowedKids: ['test-key'], now: new Date('2026-08-01T12:00:01.000Z') })).toThrow();
  });

  it('reuses stable operation identity and atomically rotates the nonce on a lost-response retry', async () => {
    const persisted = [];
    const proposalStore = {
      createOrRotateActionProposal: async (_principal, input) => {
        persisted.push(input);
        return { nonceBound: true, proposal: { id: PROPOSAL_ID, expiresAt: input.expiresAt } };
      },
    };
    let byte = 1;
    const prepare = () => prepareActionProposal({
      action: 'menu.price.set', input: { targetId: ITEM_ID, price: '1.250' }, ctx: authenticatedCtx(),
      store: proposalStore, operationId: 'stable-bedrock-tool-use',
      now: new Date('2026-08-01T12:00:00.000Z'), random: () => Buffer.alloc(32, byte++),
    });
    const first = await prepare(); const retry = await prepare();
    expect(persisted[0].idempotencyKey).toBe(persisted[1].idempotencyKey);
    expect(persisted[0].confirmationNonceHash).not.toBe(persisted[1].confirmationNonceHash);
    expect(first.proposal.id).toBe(retry.proposal.id);
    expect(first.proposal.confirmationNonce).not.toBe(retry.proposal.confirmationNonce);
  });

  it('fails closed rather than emitting a nonce for a duplicate when atomic rotation is unavailable', async () => {
    await expect(prepareActionProposal({
      action: 'menu.price.set', input: { targetId: ITEM_ID, price: '1.250' }, ctx: authenticatedCtx(),
      store: { createActionProposal: async (_principal, input) => ({ created: false, proposal: { id: PROPOSAL_ID, expiresAt: input.expiresAt } }) },
      operationId: 'duplicate-without-rotation',
    })).rejects.toMatchObject({ code: 'ACTION_RETRY_UNSAFE' });
  });
});
