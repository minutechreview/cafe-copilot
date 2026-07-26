import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const generateDailySummaryMock = vi.fn();
const embedTextMock = vi.fn();
const saveNoteMock = vi.fn();
const listNotesMock = vi.fn();
const saveDraftMock = vi.fn();
const searchDocumentsMock = vi.fn();

vi.mock('../../pos-sync/summarizer.mjs', () => ({
  generateDailySummary: generateDailySummaryMock,
}));
vi.mock('../embeddings.mjs', () => ({ embedText: embedTextMock }));
vi.mock('../../memory/store.mjs', () => ({
  saveNote: saveNoteMock,
  listNotes: listNotesMock,
  saveDraft: saveDraftMock,
  searchDocuments: searchDocumentsMock,
}));

const CTX = {
  businessId: 'biz-1',
  conversationId: 'conv-1',
  principal: { businessId: 'biz-1', actorId: 'legacy_demo', accessMode: 'legacy_demo' },
  posClient: { fakePosClient: true },
};
const CTX_WITHOUT_POS = {
  businessId: 'biz-1',
  conversationId: 'conv-1',
  principal: { businessId: 'biz-1', actorId: 'legacy_demo', accessMode: 'legacy_demo' },
};
const FAKE_POS_CLIENT = CTX.posClient;

/**
 * Builds a chainable mock mimicking Supabase's PostgrestFilterBuilder.
 */
function makeQuery(result) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

/** Builds a fake Supabase client whose `.from(table)` returns the matching query from `byTable`. */
function makeSupabase(byTable) {
  return {
    from: vi.fn((table) => {
      if (!byTable[table]) {
        throw new Error(`unexpected table in test: ${table}`);
      }
      return byTable[table];
    }),
  };
}

describe('agent/tools.mjs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('toolConfig', () => {
    it('declares the seven contracted tools', async () => {
      const { toolConfig } = await import('../tools.mjs');
      const names = toolConfig.tools.map((t) => t.toolSpec.name);
      expect(names).toEqual([
        'get_day_summary',
        'get_staff_performance',
        'get_waste_log',
        'search_memory',
        'save_note',
        'list_notes',
        'draft_purchase_order',
      ]);
    });
  });

  describe('executeTool', () => {
    it('rejects an unknown tool name', async () => {
      const { executeTool } = await import('../tools.mjs');
      await expect(executeTool('delete_everything', {}, CTX)).rejects.toThrow(
        'Unknown tool: delete_everything'
      );
    });

    describe('POS tools fail-closed behavior', () => {
      it('rejects get_day_summary when ctx.posClient is missing (no demo fallback)', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(executeTool('get_day_summary', { date: '2026-07-04' }, CTX_WITHOUT_POS)).rejects.toThrow(
          'posClient is required in execution context for POS tools'
        );
        expect(generateDailySummaryMock).not.toHaveBeenCalled();
      });

      it('rejects get_staff_performance when ctx.posClient is missing (no demo fallback)', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(
          executeTool('get_staff_performance', { start_date: '2026-07-01', end_date: '2026-07-07' }, CTX_WITHOUT_POS)
        ).rejects.toThrow('posClient is required in execution context for POS tools');
      });

      it('rejects get_waste_log when ctx.posClient is missing (no demo fallback)', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(
          executeTool('get_waste_log', { start_date: '2026-07-01', end_date: '2026-07-07' }, CTX_WITHOUT_POS)
        ).rejects.toThrow('posClient is required in execution context for POS tools');
      });

      it('rejects posClient supplied via ctx.supabaseClient (legacy property removed)', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(
          executeTool('get_day_summary', { date: '2026-07-04' }, { ...CTX_WITHOUT_POS, supabaseClient: {} })
        ).rejects.toThrow('posClient is required in execution context for POS tools');
      });
    });

    describe('get_day_summary', () => {
      it('uses the injected posClient and returns the summary for the given date', async () => {
        generateDailySummaryMock.mockResolvedValueOnce({ kpis: { gross_sales: 32400 } });
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('get_day_summary', { date: '2026-07-04' }, CTX);

        expect(generateDailySummaryMock).toHaveBeenCalledWith({
          supabase: FAKE_POS_CLIENT,
          businessId: 'biz-1',
          date: '2026-07-04',
        });
        expect(result).toEqual({ kpis: { gross_sales: 32400 } });
      });

      it('ignores caller input businessId or posClient overrides', async () => {
        generateDailySummaryMock.mockResolvedValueOnce({ kpis: { gross_sales: 15000 } });
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool(
          'get_day_summary',
          { date: '2026-07-04', businessId: 'malicious-biz-id', posClient: {} },
          CTX
        );

        expect(generateDailySummaryMock).toHaveBeenCalledWith({
          supabase: FAKE_POS_CLIENT,
          businessId: 'biz-1',
          date: '2026-07-04',
        });
        expect(result).toEqual({ kpis: { gross_sales: 15000 } });
      });

      it('returns a no_activity marker instead of null for a quiet day', async () => {
        generateDailySummaryMock.mockResolvedValueOnce(null);
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('get_day_summary', { date: '2026-06-01' }, CTX);

        expect(result).toEqual({ no_activity: true, date: '2026-06-01' });
      });

      it('rejects a malformed date without querying POS staging', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(executeTool('get_day_summary', { date: 'not-a-date' }, CTX)).rejects.toThrow(
          'date must be in YYYY-MM-DD format'
        );
      });
    });

    describe('get_staff_performance', () => {
      const BUSINESS_QUERY = () => makeQuery({ data: { id: 'biz-1', currency: 'LKR', locale_default: 'en-LK' }, error: null });

      it('builds per-staff sales, shifts, and approved refunds/voids using injected posClient', async () => {
        const sessionsQuery = makeQuery({
          data: [
            {
              id: 's1',
              staff_id: 'staff-nimal',
              closed_at: '2026-07-05T10:00:00.000Z',
              variance: -50,
              staff_profiles: { name: 'Nimal Silva', role: 'staff' },
            },
            {
              id: 's2',
              staff_id: 'staff-ruwan',
              closed_at: '2026-07-06T10:00:00.000Z',
              variance: 40,
              staff_profiles: { name: 'Ruwan Jayasinghe', role: 'staff' },
            },
          ],
          error: null,
        });
        const ordersQuery = makeQuery({
          data: [
            { till_session_id: 's1', total: 2000 },
            { till_session_id: 's1', total: 3000 },
            { till_session_id: 's2', total: 12000 },
          ],
          error: null,
        });
        const adjustmentsQuery = makeQuery({
          data: [
            { type: 'refund', amount: 350, approved_by: 'staff-owner', staff_profiles: { name: 'Maya Perera', role: 'owner' } },
            { type: 'void', amount: 500, approved_by: 'staff-owner', staff_profiles: { name: 'Maya Perera', role: 'owner' } },
          ],
          error: null,
        });
        const supabase = makeSupabase({
          businesses: BUSINESS_QUERY(),
          till_sessions: sessionsQuery,
          orders: ordersQuery,
          order_adjustments: adjustmentsQuery,
        });

        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool(
          'get_staff_performance',
          { start_date: '2026-07-01', end_date: '2026-07-07' },
          { ...CTX, posClient: supabase }
        );

        // Regression guard: the POS schema links till_sessions to staff_profiles twice
        // (staff_id = who worked the shift, closed_by = who counted it down), both as
        // composite (business_id, ...) FKs. A `!staff_id` column hint stopped resolving and an
        // unhinted embed is ambiguous — which broke get_staff_performance live while every
        // mocked test still passed, because the mocks never resolve the relationship. Pin the
        // exact constraint-name hint so that failure mode cannot return silently.
        expect(sessionsQuery.select).toHaveBeenCalledWith(
          expect.stringContaining('staff_profiles!till_sessions_business_staff_fkey(name,role)')
        );
        expect(sessionsQuery.gte).toHaveBeenCalledWith('opened_at', '2026-06-30T18:30:00.000Z');
        expect(sessionsQuery.lt).toHaveBeenCalledWith('opened_at', '2026-07-07T18:30:00.000Z');
        expect(ordersQuery.in).toHaveBeenCalledWith('till_session_id', ['s1', 's2']);
        expect(adjustmentsQuery.gte).toHaveBeenCalledWith('created_at', '2026-06-30T18:30:00.000Z');

        expect(result).toEqual({
          range: { start_date: '2026-07-01', end_date: '2026-07-07' },
          currency: 'LKR',
          staff: [
            {
              name: 'Ruwan Jayasinghe',
              role: 'staff',
              total_sales: 12000,
              order_count: 1,
              average_transaction_value: 12000,
              shifts_worked: 1,
              net_over_short: 40,
              refunds_approved: { count: 0, value: 0 },
              voids_approved: { count: 0, value: 0 },
            },
            {
              name: 'Nimal Silva',
              role: 'staff',
              total_sales: 5000,
              order_count: 2,
              average_transaction_value: 2500,
              shifts_worked: 1,
              net_over_short: -50,
              refunds_approved: { count: 0, value: 0 },
              voids_approved: { count: 0, value: 0 },
            },
            {
              name: 'Maya Perera',
              role: 'owner',
              total_sales: 0,
              order_count: 0,
              average_transaction_value: 0,
              shifts_worked: 0,
              net_over_short: 0,
              refunds_approved: { count: 1, value: 350 },
              voids_approved: { count: 1, value: 500 },
            },
          ],
          totals: { total_sales: 17000, order_count: 3, shifts_worked: 2, net_over_short: -10 },
        });
      });

      it('returns a no_activity marker and skips the orders query when no shifts exist', async () => {
        const supabase = makeSupabase({
          businesses: BUSINESS_QUERY(),
          till_sessions: makeQuery({ data: [], error: null }),
          order_adjustments: makeQuery({ data: [], error: null }),
        });
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool(
          'get_staff_performance',
          { start_date: '2026-07-01', end_date: '2026-07-01' },
          { ...CTX, posClient: supabase }
        );

        expect(supabase.from).not.toHaveBeenCalledWith('orders');
        expect(result).toMatchObject({ staff: [], no_activity: true });
      });

      it('rejects a malformed date range without querying POS staging', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(
          executeTool('get_staff_performance', { start_date: '2026-07-07', end_date: '2026-07-01' }, CTX)
        ).rejects.toThrow('end_date must not be before start_date');
        await expect(
          executeTool('get_staff_performance', { start_date: 'nope', end_date: '2026-07-01' }, CTX)
        ).rejects.toThrow('start_date must be in YYYY-MM-DD format');
      });
    });

    describe('get_waste_log', () => {
      const BUSINESS_QUERY = () => makeQuery({ data: { id: 'biz-1', currency: 'LKR', locale_default: 'en-LK' }, error: null });

      it('maps entries using injected posClient and aggregates totals by reason and item', async () => {
        const wasteQuery = makeQuery({
          data: [
            {
              qty: 2,
              reason_code: 'damaged',
              logged_by: 'Nimal Silva',
              timestamp: '2026-07-02T12:30:00.000Z',
              menu_items: { name: 'Butter Croissant', price: 650 },
            },
            {
              qty: 1,
              reason_code: 'quality',
              logged_by: 'Ruwan Jayasinghe',
              timestamp: '2026-07-03T19:00:00.000Z',
              menu_items: { name: 'Egg Hopper Plate', price: 1450 },
            },
          ],
          error: null,
        });
        const supabase = makeSupabase({ businesses: BUSINESS_QUERY(), waste_comp_logs: wasteQuery });
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool(
          'get_waste_log',
          { start_date: '2026-07-01', end_date: '2026-07-07' },
          { ...CTX, posClient: supabase }
        );

        expect(wasteQuery.gte).toHaveBeenCalledWith('timestamp', '2026-06-30T18:30:00.000Z');
        expect(wasteQuery.lt).toHaveBeenCalledWith('timestamp', '2026-07-07T18:30:00.000Z');

        expect(result).toEqual({
          range: { start_date: '2026-07-01', end_date: '2026-07-07' },
          currency: 'LKR',
          entries: [
            {
              date: '2026-07-02',
              item: 'Butter Croissant',
              quantity: 2,
              reason: 'Damaged',
              reason_code: 'damaged',
              approx_value: 1300,
              logged_by: 'Nimal Silva',
            },
            {
              date: '2026-07-04',
              item: 'Egg Hopper Plate',
              quantity: 1,
              reason: 'Quality issue',
              reason_code: 'quality',
              approx_value: 1450,
              logged_by: 'Ruwan Jayasinghe',
            },
          ],
          totals: {
            total_events: 2,
            total_quantity: 3,
            approx_total_value: 2750,
            approx_value_note: 'Approximate, based on current menu prices which may have changed since these were logged.',
            by_reason: [
              { reason: 'Damaged', reason_code: 'damaged', count: 1, quantity: 2, approx_value: 1300 },
              { reason: 'Quality issue', reason_code: 'quality', count: 1, quantity: 1, approx_value: 1450 },
            ],
            by_item: [
              { item: 'Butter Croissant', count: 1, quantity: 2, approx_value: 1300 },
              { item: 'Egg Hopper Plate', count: 1, quantity: 1, approx_value: 1450 },
            ],
          },
        });
      });

      it('falls back to raw reason code, "Unknown item", and no logged_by field when data is sparse', async () => {
        const wasteQuery = makeQuery({
          data: [{ qty: 1, reason_code: 'mystery', logged_by: null, timestamp: '2026-07-02T12:00:00.000Z', menu_items: null }],
          error: null,
        });
        const supabase = makeSupabase({ businesses: BUSINESS_QUERY(), waste_comp_logs: wasteQuery });
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool(
          'get_waste_log',
          { start_date: '2026-07-01', end_date: '2026-07-07' },
          { ...CTX, posClient: supabase }
        );

        expect(result.entries).toEqual([
          { date: '2026-07-02', item: 'Unknown item', quantity: 1, reason: 'mystery', reason_code: 'mystery', approx_value: 0 },
        ]);
      });

      it('returns a no_activity marker for an empty range', async () => {
        const supabase = makeSupabase({ businesses: BUSINESS_QUERY(), waste_comp_logs: makeQuery({ data: [], error: null }) });
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool(
          'get_waste_log',
          { start_date: '2026-07-01', end_date: '2026-07-07' },
          { ...CTX, posClient: supabase }
        );

        expect(result).toMatchObject({ entries: [], no_activity: true });
      });

      it('rejects a malformed date range without querying POS staging', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(
          executeTool('get_waste_log', { start_date: '2026-07-01', end_date: 'nope' }, CTX)
        ).rejects.toThrow('end_date must be in YYYY-MM-DD format');
      });
    });

    describe('search_memory', () => {
      it('embeds the query and searches documents with a default k of 5', async () => {
        embedTextMock.mockResolvedValueOnce([0.1, 0.2]);
        searchDocumentsMock.mockResolvedValueOnce([{ id: 'doc-1', distance: 0.05 }]);
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('search_memory', { query: 'refunds lately' }, CTX);

        expect(embedTextMock).toHaveBeenCalledWith('refunds lately');
        expect(searchDocumentsMock).toHaveBeenCalledWith(
          { businessId: 'biz-1', actorId: 'legacy_demo', accessMode: 'legacy_demo' },
          [0.1, 0.2],
          5
        );
        expect(result).toEqual({ results: [{ id: 'doc-1', distance: 0.05 }] });
      });

      it('honours a custom k and custom principal', async () => {
        embedTextMock.mockResolvedValueOnce([0.1]);
        searchDocumentsMock.mockResolvedValueOnce([]);
        const { executeTool } = await import('../tools.mjs');
        const customPrincipal = { businessId: 'biz-1', actorId: 'u-100', accessMode: 'authenticated' };

        await executeTool('search_memory', { query: 'milk', k: 2 }, { ...CTX, principal: customPrincipal });

        expect(searchDocumentsMock).toHaveBeenCalledWith(customPrincipal, [0.1], 2);
      });

      it('rejects an empty query', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(executeTool('search_memory', { query: '  ' }, CTX)).rejects.toThrow(
          'query is required'
        );
      });

      it('rejects tool execution when ctx is missing or null', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(executeTool('search_memory', { query: 'test' }, null)).rejects.toThrow(
          'tool context is required'
        );
      });

      it('rejects tool execution when ctx.principal is missing', async () => {
        const { executeTool } = await import('../tools.mjs');
        const noPrincipalCtx = { businessId: 'demo-cafe' };
        await expect(executeTool('search_memory', { query: 'test' }, noPrincipalCtx)).rejects.toThrow(
          'ctx.principal is required'
        );
      });

      it('rejects tool execution when ctx.businessId disagrees with ctx.principal.businessId', async () => {
        const { executeTool } = await import('../tools.mjs');
        const mismatchedCtx = {
          businessId: 'biz-A',
          principal: { businessId: 'biz-B', actorId: 'u-1', accessMode: 'authenticated' },
        };
        await expect(executeTool('search_memory', { query: 'test' }, mismatchedCtx)).rejects.toThrow(
          'businessId mismatch in tool context'
        );
      });

      it('rejects tool execution when ctx.principal shape is invalid', async () => {
        const { executeTool } = await import('../tools.mjs');
        const invalidCtx = {
          principal: { businessId: 'biz-A' }, // missing actorId/accessMode
        };
        await expect(executeTool('search_memory', { query: 'test' }, invalidCtx)).rejects.toThrow(
          'invalid principal shape in tool context'
        );
      });
    });

    describe('save_note / list_notes', () => {
      it('saves a note tagged with source=chat and principal', async () => {
        saveNoteMock.mockResolvedValueOnce('note-1');
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('save_note', { content: 'winter menu in November' }, CTX);

        expect(saveNoteMock).toHaveBeenCalledWith(
          { businessId: 'biz-1', actorId: 'legacy_demo', accessMode: 'legacy_demo' },
          { content: 'winter menu in November', source: 'chat' }
        );
        expect(result).toEqual({ id: 'note-1', content: 'winter menu in November', saved: true });
      });

      it('lists notes for the business using principal', async () => {
        listNotesMock.mockResolvedValueOnce([{ id: 'note-1', content: 'x' }]);
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('list_notes', {}, CTX);

        expect(listNotesMock).toHaveBeenCalledWith({
          businessId: 'biz-1',
          actorId: 'legacy_demo',
          accessMode: 'legacy_demo',
        });
        expect(result).toEqual({ notes: [{ id: 'note-1', content: 'x' }] });
      });
    });

    describe('draft_purchase_order', () => {
      it('validates items, saves the draft, and returns it marked for review', async () => {
        saveDraftMock.mockResolvedValueOnce('draft-1');
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool(
          'draft_purchase_order',
          { items: [{ name: 'coffee beans', quantity: 20, unit: 'kg' }, { name: 'milk', quantity: 30, unit: 'L' }] },
          CTX
        );

        expect(saveDraftMock).toHaveBeenCalledWith(
          { businessId: 'biz-1', actorId: 'legacy_demo', accessMode: 'legacy_demo' },
          {
            conversationId: 'conv-1',
            kind: 'purchase_order',
            payload: {
              kind: 'purchase_order',
              supplier: null,
              items: [
                { name: 'coffee beans', quantity: 20, unit: 'kg' },
                { name: 'milk', quantity: 30, unit: 'L' },
              ],
              notes: null,
            },
          }
        );
        expect(result).toEqual({
          id: 'draft-1',
          kind: 'purchase_order',
          supplier: null,
          items: [
            { name: 'coffee beans', quantity: 20, unit: 'kg' },
            { name: 'milk', quantity: 30, unit: 'L' },
          ],
          notes: null,
          saved_for_review: true,
        });
      });

      it('rejects an empty items array', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(executeTool('draft_purchase_order', { items: [] }, CTX)).rejects.toThrow(
          'items must be a non-empty array'
        );
        expect(saveDraftMock).not.toHaveBeenCalled();
      });

      it('rejects an item with a non-positive quantity', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(
          executeTool('draft_purchase_order', { items: [{ name: 'milk', quantity: 0 }] }, CTX)
        ).rejects.toThrow('items[0].quantity must be a positive number');
      });

      it('rejects an item missing a name', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(
          executeTool('draft_purchase_order', { items: [{ quantity: 5 }] }, CTX)
        ).rejects.toThrow('items[0].name is required');
      });
    });
  });

  describe('resolveBusinessContext', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves business-local today from a non-UTC locale offset at a UTC instant where the local date is already the next day', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-24T20:00:00.000Z')); // en-LK is +05:30, so local time is already 2026-07-25
      const supabase = makeSupabase({
        businesses: makeQuery({ data: { id: 'biz-1', currency: 'LKR', locale_default: 'en-LK' }, error: null }),
      });
      const { resolveBusinessContext } = await import('../tools.mjs');

      const result = await resolveBusinessContext(supabase, 'biz-1');

      expect(result).toEqual({ today: '2026-07-25', currency: 'LKR', locale: 'en-LK' });
    });

    it('returns null (not a throw) when the business lookup errors', async () => {
      const supabase = makeSupabase({
        businesses: makeQuery({ data: null, error: { message: 'connection refused' } }),
      });
      const { resolveBusinessContext } = await import('../tools.mjs');

      await expect(resolveBusinessContext(supabase, 'biz-1')).resolves.toBeNull();
    });

    it('returns null (not a throw) when the business row does not exist', async () => {
      const supabase = makeSupabase({
        businesses: makeQuery({ data: null, error: null }),
      });
      const { resolveBusinessContext } = await import('../tools.mjs');

      await expect(resolveBusinessContext(supabase, 'biz-1')).resolves.toBeNull();
    });

    it('returns null without querying when posClient or businessId is missing', async () => {
      const { resolveBusinessContext } = await import('../tools.mjs');

      expect(await resolveBusinessContext(null, 'biz-1')).toBeNull();
      expect(await resolveBusinessContext({}, undefined)).toBeNull();
    });

    it('propagates an abort instead of swallowing it into null', async () => {
      const controller = new AbortController();
      controller.abort();
      const { resolveBusinessContext } = await import('../tools.mjs');

      await expect(resolveBusinessContext({}, 'biz-1', controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });
});
