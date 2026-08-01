import { describe, expect, it, vi } from 'vitest';
import { ACTION_TARGET_KINDS, findActionTargets } from '../actions/index.mjs';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

function builder(data, calls) {
  const value = {
    select(...args) { calls.push(['select', ...args]); return value; },
    eq(...args) { calls.push(['eq', ...args]); return value; },
    is(...args) { calls.push(['is', ...args]); return value; },
    ilike(...args) { calls.push(['ilike', ...args]); return value; },
    order(...args) { calls.push(['order', ...args]); return value; },
    limit(...args) { calls.push(['limit', ...args]); return value; },
    then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
  };
  return value;
}

function context(kind, query = 'latte') {
  const calls = [];
  const rows = {
    menu_item: [{ id: TARGET_ID, name: 'Latte % special', revision: 4, price: '1.250', available: true }],
    inventory_item: [{ id: TARGET_ID, name: 'Milk', revision: 5, unit: 'L', operational_availability: 'available' }],
    supplier: [{ id: TARGET_ID, name: 'Dairy Co' }],
    open_till_session: [{ id: TARGET_ID, till_id: '44444444-4444-4444-8444-444444444444', opened_at: '2026-08-01T08:00:00Z', tills: { id: '44444444-4444-4444-8444-444444444444', name: 'Front Till' } }],
    draft_purchase_order: [{ id: TARGET_ID, revision: 6, status: 'draft', supplier_id: '55555555-5555-4555-8555-555555555555', suppliers: { id: '55555555-5555-4555-8555-555555555555', name: 'Dairy Co' } }],
  };
  return {
    calls,
    ctx: {
      principal: { businessId: BUSINESS_ID, actorId: ACTOR_ID, accessMode: 'authenticated' },
      businessContext: { currency: 'KWD' },
      posClient: { from(table) { calls.push(['from', table]); return builder(rows[kind] ?? [], calls); } },
      actionDependencies: {
        operationalStore: {
          findOperationalRecords: vi.fn().mockResolvedValue([{ id: TARGET_ID, businessId: BUSINESS_ID, title: `Check ${query}`, version: 7, status: 'open' }]),
        },
      },
    },
  };
}

describe('find_action_targets boundary', () => {
  it.each(ACTION_TARGET_KINDS)('returns minimal tenant-scoped %s targets', async (kind) => {
    const { ctx, calls } = context(kind);
    const result = await findActionTargets({ kind, query: 'latte' }, ctx);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toEqual(expect.objectContaining({ kind, id: TARGET_ID, label: expect.any(String) }));
    expect(result.targets[0]).not.toHaveProperty('businessId');
    expect(result.targets[0]).not.toHaveProperty('contact');
    if (kind !== 'operational_record') {
      expect(calls).toContainEqual(['eq', 'business_id', BUSINESS_ID]);
      expect(calls).toContainEqual(['limit', 10]);
    }
    if (kind === 'menu_item') expect(calls).toContainEqual(['eq', 'active', true]);
    if (kind === 'open_till_session') {
      expect(calls).toContainEqual(['is', 'closed_at', null]);
      expect(calls).toContainEqual(['select', 'id,till_id,opened_at,tills!till_sessions_business_till_fkey!inner(id,name)']);
    }
    if (kind === 'draft_purchase_order') {
      expect(calls).toContainEqual(['eq', 'status', 'draft']);
      expect(calls).toContainEqual(['select', 'id,revision,status,supplier_id,suppliers!purchase_orders_business_id_supplier_id_fkey!inner(id,name)']);
    }
  });

  it('escapes wildcard metacharacters and keeps labels as returned data', async () => {
    const { ctx, calls } = context('menu_item');
    const result = await findActionTargets({ kind: 'menu_item', query: '%_\\latte' }, ctx);
    expect(calls).toContainEqual(['ilike', 'name', '%\\%\\_\\\\latte%']);
    expect(result.targets[0].label).toBe('Latte % special');
  });

  it('rejects unknown kinds, unknown fields, oversized queries, and demo access before POS', async () => {
    const { ctx } = context('menu_item');
    await expect(findActionTargets({ kind: 'orders', query: 'x' }, ctx)).rejects.toMatchObject({ code: 'INVALID_TARGET_SEARCH' });
    await expect(findActionTargets({ kind: 'menu_item', query: 'x', table: 'orders' }, ctx)).rejects.toThrow('unknown field');
    await expect(findActionTargets({ kind: 'menu_item', query: 'x'.repeat(81) }, ctx)).rejects.toThrow('1..80');
    const from = vi.fn();
    await expect(findActionTargets({ kind: 'menu_item', query: 'latte' }, { ...ctx, principal: { businessId: BUSINESS_ID, actorId: 'demo', accessMode: 'demo' }, posClient: { from } })).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    expect(from).not.toHaveBeenCalled();
  });
});
