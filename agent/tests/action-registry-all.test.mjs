import { describe, expect, it, vi } from 'vitest';
import { ACTION_REGISTRY, prepareActionProposal } from '../actions/index.mjs';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const SUPPLIER_ID = '55555555-5555-4555-8555-555555555555';
const MENU_ID = '66666666-6666-4666-8666-666666666666';

function queryFixture(data, calls) {
  const builder = {
    select(value) { calls.push(['select', value]); return builder; },
    eq(...args) { calls.push(['eq', ...args]); return builder; },
    is(...args) { calls.push(['is', ...args]); return builder; },
    in(...args) { calls.push(['in', ...args]); return builder; },
    order(...args) { calls.push(['order', ...args]); return builder; },
    abortSignal() { return builder; },
    async maybeSingle() { return { data: Array.isArray(data) ? data[0] ?? null : data, error: null }; },
    then(resolve, reject) { return Promise.resolve({ data: Array.isArray(data) ? data : [data], error: null }).then(resolve, reject); },
  };
  return builder;
}

function fixtures() {
  const calls = [];
  const inventory = { id: TARGET_ID, revision: 12, name: 'Milk', unit: 'L', operational_availability: 'available', availability_reason: null, current_stock: '8.500' };
  const rows = {
    menu_items: { id: TARGET_ID, revision: 7, name: 'Latte', price: '1.000', active: true, available: true },
    inventory_items: [inventory],
    recipe_items: [{ inventory_item_id: TARGET_ID, menu_item_id: MENU_ID, qty_per_unit: '0.250', menu_items: { id: MENU_ID, revision: 4, name: 'Flat White', active: true, available: true } }],
    till_sessions: { id: TARGET_ID, opened_at: '2026-08-01T08:00:00.000Z', closed_at: null, till_id: MENU_ID, tills: { id: MENU_ID, name: 'Front Register' } },
    suppliers: { id: SUPPLIER_ID, name: 'Dairy Co' },
    purchase_orders: { id: TARGET_ID, revision: 3, status: 'draft', supplier_id: SUPPLIER_ID },
  };
  return { calls, posClient: { from(table) { calls.push(['from', table]); return queryFixture(rows[table], calls); }, rpc: vi.fn() } };
}

function actionInput(action) {
  if (action === 'menu.availability.set') return { targetId: TARGET_ID, available: false };
  if (action === 'menu.price.set') return { targetId: TARGET_ID, price: '1.250' };
  if (action === 'ingredient.availability.set') return { targetId: TARGET_ID, availability: 'unavailable', reason: 'Delivery delayed' };
  if (action === 'waste.record') return { targetId: TARGET_ID, quantity: '2.5', reason: 'Quality issue' };
  if (action === 'cash.paid_in_out.record') return { targetId: TARGET_ID, direction: 'out', amount: '5.000', reason: 'Courier float' };
  if (action === 'stock.count.correct') return { targetId: TARGET_ID, count: '8.5', reason: 'Physical count' };
  if (action === 'purchase_order.draft.create') return { supplierId: SUPPLIER_ID, lines: [{ inventoryItemId: TARGET_ID, quantity: '2.5' }] };
  if (action === 'purchase_order.draft.cancel') return { targetId: TARGET_ID };
  if (action === 'navigation.open') return { surface: 'inventory', recordId: TARGET_ID };
  if (action === 'report.export_handoff') return { reportKind: 'inventory', startDate: '2026-08-01', endDate: '2026-08-01' };
  const verb = action.split('.')[2];
  if (verb === 'create') return { title: 'Check delivery', body: 'Confirm before close' };
  if (verb === 'supersede') return { recordId: TARGET_ID, title: 'Updated delivery', body: 'Confirm by noon' };
  return { recordId: TARGET_ID };
}

function dependencies(action, captured) {
  return {
    proposalLimiter: { consume: vi.fn().mockResolvedValue({ allowed: true }) },
    operationalStore: {
      getOperationalRecord: vi.fn().mockResolvedValue({ id: TARGET_ID, businessId: BUSINESS_ID, recordType: action.split('.')[1], status: 'open', version: 6, title: 'Old title', body: 'Old body' }),
    },
    proposalStore: {
      createOrRotateActionProposal: vi.fn(async (_principal, input) => {
        captured.push(input);
        return { nonceBound: true, proposal: { id: '44444444-4444-4444-8444-444444444444', expiresAt: input.expiresAt } };
      }),
    },
  };
}

describe('every approved action', () => {
  it.each(Object.keys(ACTION_REGISTRY))('%s has a complete structured presentation and only prepares', async (action) => {
    const fixture = fixtures(); const captured = []; const actionDependencies = dependencies(action, captured);
    const result = await prepareActionProposal({
      action, input: actionInput(action), operationId: `tool-${action}`,
      ctx: {
        businessId: BUSINESS_ID, conversationId: '77777777-7777-4777-8777-777777777777',
        principal: { businessId: BUSINESS_ID, actorId: ACTOR_ID, accessMode: 'authenticated' },
        posClient: fixture.posClient, businessContext: { currency: 'KWD' }, actionDependencies,
        actionPolicy: { globalEnabled: true, businessEnabled: true, actionEnabled: true, version: 9 },
      },
      store: actionDependencies.proposalStore,
    });

    expect(Object.keys(result.proposal.effect)).toEqual(['target', 'before', 'after', 'impact']);
    expect(result.proposal.effect.target).toEqual(expect.objectContaining({ kind: expect.any(String), label: expect.any(String) }));
    expect(result.proposal.effect.impact).toEqual(expect.objectContaining({ warnings: expect.any(Array) }));
    expect(result.proposal.summary).toEqual(expect.any(String));
    expect(result.modelResult).not.toHaveProperty('confirmationNonce');
    expect(JSON.stringify(result.modelResult)).not.toContain(result.proposal.confirmationNonce);
    expect(captured).toHaveLength(1);
    if (action.startsWith('ops.') && !action.endsWith('.create')) {
      expect(captured[0].normalizedPayload.expectedVersion).toBe(6);
      expect(captured[0].expectedStateHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(fixture.posClient.rpc).not.toHaveBeenCalled();
  });

  it('uses the real POS field names and server-owned PO units/snapshot', async () => {
    const fixture = fixtures(); const captured = []; const action = 'purchase_order.draft.create'; const actionDependencies = dependencies(action, captured);
    await prepareActionProposal({ action, input: actionInput(action), operationId: 'po-real-schema', ctx: { principal: { businessId: BUSINESS_ID, actorId: ACTOR_ID, accessMode: 'authenticated' }, posClient: fixture.posClient, businessContext: { currency: 'KWD' }, actionDependencies, actionPolicy: { globalEnabled: true, businessEnabled: true, actionEnabled: true, version: 2 } }, store: actionDependencies.proposalStore });
    expect(fixture.calls).toContainEqual(['select', 'id,name']);
    expect(fixture.calls).toContainEqual(['select', 'id,revision,name,unit']);
    expect(captured[0].normalizedPayload.lines[0]).toMatchObject({ quantity: '2.500', unit: 'L', itemRevision: 12 });
    expect(captured[0].normalizedPayload.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(captured[0].normalizedPayload).not.toHaveProperty('expectedSupplierRevision');
    const result = await prepareActionProposal({ action, input: actionInput(action), operationId: 'po-label-check', ctx: { principal: { businessId: BUSINESS_ID, actorId: ACTOR_ID, accessMode: 'authenticated' }, posClient: fixture.posClient, businessContext: { currency: 'KWD' }, actionDependencies, actionPolicy: { globalEnabled: true, businessEnabled: true, actionEnabled: true, version: 2 } }, store: actionDependencies.proposalStore });
    expect(result.proposal.effect.target).toEqual({ kind: 'supplier', id: SUPPLIER_ID, label: 'Dairy Co' });
  });

  it('queries menu.active, recipe qty_per_unit, and open cash via closed_at without cash revision', async () => {
    for (const action of ['menu.price.set', 'ingredient.availability.set', 'cash.paid_in_out.record']) {
      const fixture = fixtures(); const captured = []; const actionDependencies = dependencies(action, captured);
      const result = await prepareActionProposal({ action, input: actionInput(action), operationId: action, ctx: { principal: { businessId: BUSINESS_ID, actorId: ACTOR_ID, accessMode: 'authenticated' }, posClient: fixture.posClient, businessContext: { currency: 'KWD' }, actionDependencies, actionPolicy: { globalEnabled: true, businessEnabled: true, actionEnabled: true, version: 2 } }, store: actionDependencies.proposalStore });
      if (action === 'menu.price.set') expect(fixture.calls).toContainEqual(['eq', 'active', true]);
      if (action === 'ingredient.availability.set') {
        expect(fixture.calls.some((call) => call[0] === 'select' && call[1].includes('qty_per_unit'))).toBe(true);
        expect(result.proposal.effect.impact.affectedMenuItems[0].menuItemName).toBe('Flat White');
      }
      if (action === 'cash.paid_in_out.record') {
        expect(fixture.calls).toContainEqual(['is', 'closed_at', null]);
        expect(fixture.calls).toContainEqual(['select', 'id,opened_at,closed_at,till_id,tills!till_sessions_business_till_fkey(id,name)']);
        expect(captured[0].normalizedPayload).toMatchObject({ expectedOpen: true });
        expect(captured[0].normalizedPayload).not.toHaveProperty('expectedRevision');
        expect(result.proposal.effect.target).toEqual({ kind: 'till_session', id: TARGET_ID, label: 'Front Register — open session', till: { id: MENU_ID, label: 'Front Register' } });
      }
    }
  });

  it('rejects duplicate PO item ids before resolving a supplier or persisting', async () => {
    const fixture = fixtures(); const captured = []; const action = 'purchase_order.draft.create'; const actionDependencies = dependencies(action, captured);
    await expect(prepareActionProposal({
      action,
      input: { supplierId: SUPPLIER_ID, lines: [{ inventoryItemId: TARGET_ID, quantity: '1' }, { inventoryItemId: TARGET_ID, quantity: '2.5' }] },
      operationId: 'duplicate-po-lines',
      ctx: { principal: { businessId: BUSINESS_ID, actorId: ACTOR_ID, accessMode: 'authenticated' }, posClient: fixture.posClient, businessContext: { currency: 'KWD' }, actionDependencies, actionPolicy: { globalEnabled: true, businessEnabled: true, actionEnabled: true, version: 2 } },
      store: actionDependencies.proposalStore,
    })).rejects.toMatchObject({ code: 'INVALID_ACTION_INPUT' });
    expect(fixture.calls.some((call) => call[0] === 'from' && call[1] === 'suppliers')).toBe(false);
    expect(captured).toHaveLength(0);
  });
});
