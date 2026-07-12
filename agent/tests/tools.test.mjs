import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateDailySummaryMock = vi.fn();
const embedTextMock = vi.fn();
const getPosClientMock = vi.fn();
const saveNoteMock = vi.fn();
const listNotesMock = vi.fn();
const saveDraftMock = vi.fn();
const searchDocumentsMock = vi.fn();

vi.mock('../../pos-sync/summarizer.mjs', () => ({
  generateDailySummary: generateDailySummaryMock,
}));
vi.mock('../embeddings.mjs', () => ({ embedText: embedTextMock }));
vi.mock('../pos-client.mjs', () => ({ getPosClient: getPosClientMock }));
vi.mock('../../memory/store.mjs', () => ({
  saveNote: saveNoteMock,
  listNotes: listNotesMock,
  saveDraft: saveDraftMock,
  searchDocuments: searchDocumentsMock,
}));

const CTX = { businessId: 'biz-1', conversationId: 'conv-1' };

describe('agent/tools.mjs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('toolConfig', () => {
    it('declares the five contracted tools', async () => {
      const { toolConfig } = await import('../tools.mjs');
      const names = toolConfig.tools.map((t) => t.toolSpec.name);
      expect(names).toEqual([
        'get_day_summary',
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

    describe('get_day_summary', () => {
      it('authenticates to POS staging and returns the summary for the given date', async () => {
        const fakeSupabase = { fake: true };
        getPosClientMock.mockResolvedValueOnce(fakeSupabase);
        generateDailySummaryMock.mockResolvedValueOnce({ kpis: { gross_sales: 32400 } });
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('get_day_summary', { date: '2026-07-04' }, CTX);

        expect(generateDailySummaryMock).toHaveBeenCalledWith({
          supabase: fakeSupabase,
          businessId: 'biz-1',
          date: '2026-07-04',
        });
        expect(result).toEqual({ kpis: { gross_sales: 32400 } });
      });

      it('returns a no_activity marker instead of null for a quiet day', async () => {
        getPosClientMock.mockResolvedValueOnce({});
        generateDailySummaryMock.mockResolvedValueOnce(null);
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('get_day_summary', { date: '2026-06-01' }, CTX);

        expect(result).toEqual({ no_activity: true, date: '2026-06-01' });
      });

      it('rejects a malformed date without calling POS staging', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(executeTool('get_day_summary', { date: 'not-a-date' }, CTX)).rejects.toThrow(
          'date must be in YYYY-MM-DD format'
        );
        expect(getPosClientMock).not.toHaveBeenCalled();
      });
    });

    describe('search_memory', () => {
      it('embeds the query and searches documents with a default k of 5', async () => {
        embedTextMock.mockResolvedValueOnce([0.1, 0.2]);
        searchDocumentsMock.mockResolvedValueOnce([{ id: 'doc-1', distance: 0.05 }]);
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('search_memory', { query: 'refunds lately' }, CTX);

        expect(embedTextMock).toHaveBeenCalledWith('refunds lately');
        expect(searchDocumentsMock).toHaveBeenCalledWith('biz-1', [0.1, 0.2], 5);
        expect(result).toEqual({ results: [{ id: 'doc-1', distance: 0.05 }] });
      });

      it('honours a custom k', async () => {
        embedTextMock.mockResolvedValueOnce([0.1]);
        searchDocumentsMock.mockResolvedValueOnce([]);
        const { executeTool } = await import('../tools.mjs');

        await executeTool('search_memory', { query: 'milk', k: 2 }, CTX);

        expect(searchDocumentsMock).toHaveBeenCalledWith('biz-1', [0.1], 2);
      });

      it('rejects an empty query', async () => {
        const { executeTool } = await import('../tools.mjs');
        await expect(executeTool('search_memory', { query: '  ' }, CTX)).rejects.toThrow(
          'query is required'
        );
      });
    });

    describe('save_note / list_notes', () => {
      it('saves a note tagged with source=chat', async () => {
        saveNoteMock.mockResolvedValueOnce('note-1');
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('save_note', { content: 'winter menu in November' }, CTX);

        expect(saveNoteMock).toHaveBeenCalledWith({
          businessId: 'biz-1',
          content: 'winter menu in November',
          source: 'chat',
        });
        expect(result).toEqual({ id: 'note-1', content: 'winter menu in November', saved: true });
      });

      it('lists notes for the business', async () => {
        listNotesMock.mockResolvedValueOnce([{ id: 'note-1', content: 'x' }]);
        const { executeTool } = await import('../tools.mjs');

        const result = await executeTool('list_notes', {}, CTX);

        expect(listNotesMock).toHaveBeenCalledWith('biz-1');
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

        expect(saveDraftMock).toHaveBeenCalledWith({
          businessId: 'biz-1',
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
        });
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
});
