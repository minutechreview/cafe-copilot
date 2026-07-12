import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();
const endMock = vi.fn();

const PoolMock = vi.fn().mockImplementation(() => ({
  query: queryMock,
  connect: connectMock,
  end: endMock,
}));

vi.mock('pg', () => ({
  default: { Pool: PoolMock },
}));

describe('memory/store.mjs', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    endMock.mockReset();
    PoolMock.mockClear();
    connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    process.env.CRDB_CONNECTION_STRING = 'postgresql://test:test@localhost:26257/test';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('lazily builds a single pool from CRDB_CONNECTION_STRING on first use', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'conv-1' }] });
    const { createConversation } = await import('../store.mjs');

    await createConversation({ businessId: 'demo-cafe' });
    await createConversation({ businessId: 'demo-cafe' });

    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock).toHaveBeenCalledWith({ connectionString: process.env.CRDB_CONNECTION_STRING });
  });

  describe('createConversation', () => {
    it('inserts and returns the new id', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
      const { createConversation } = await import('../store.mjs');

      const id = await createConversation({ businessId: 'demo-cafe', title: 'hello' });

      expect(id).toBe('conv-1');
      expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO conversations'), [
        'demo-cafe',
        'hello',
      ]);
    });

    it('rejects a missing businessId', async () => {
      const { createConversation } = await import('../store.mjs');
      await expect(createConversation({})).rejects.toThrow('businessId is required');
      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  describe('appendMessage', () => {
    it('runs INSERT + UPDATE inside a transaction and commits', async () => {
      clientQueryMock
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] }) // INSERT
        .mockResolvedValueOnce(undefined) // UPDATE conversations
        .mockResolvedValueOnce(undefined); // COMMIT

      const { appendMessage } = await import('../store.mjs');
      const id = await appendMessage({ conversationId: 'conv-1', role: 'user', content: 'hi' });

      expect(id).toBe('msg-1');
      expect(clientQueryMock).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(clientQueryMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO messages'),
        ['conv-1', 'user', 'hi']
      );
      expect(clientQueryMock).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('UPDATE conversations'),
        ['conv-1']
      );
      expect(clientQueryMock).toHaveBeenNthCalledWith(4, 'COMMIT');
      expect(releaseMock).toHaveBeenCalledTimes(1);
    });

    it('rolls back and rethrows if the insert fails', async () => {
      clientQueryMock
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('insert failed')); // INSERT

      const { appendMessage } = await import('../store.mjs');

      await expect(
        appendMessage({ conversationId: 'conv-1', role: 'user', content: 'hi' })
      ).rejects.toThrow('insert failed');

      expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
      expect(releaseMock).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid role', async () => {
      const { appendMessage } = await import('../store.mjs');
      await expect(
        appendMessage({ conversationId: 'conv-1', role: 'system', content: 'hi' })
      ).rejects.toThrow("role must be 'user' or 'assistant'");
      expect(connectMock).not.toHaveBeenCalled();
    });
  });

  describe('getRecentMessages', () => {
    it('returns rows oldest-first (DB gives newest-first, LIMITed)', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          { role: 'assistant', content: 'second', created_at: new Date('2026-01-01T00:00:02Z') },
          { role: 'user', content: 'first', created_at: new Date('2026-01-01T00:00:01Z') },
        ],
      });
      const { getRecentMessages } = await import('../store.mjs');

      const result = await getRecentMessages('conv-1', 12);

      expect(result.map((m) => m.content)).toEqual(['first', 'second']);
      expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('ORDER BY created_at DESC'), [
        'conv-1',
        12,
      ]);
    });
  });

  describe('upsertDocument', () => {
    it('inserts a new document with a bracketed vector literal', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'doc-1' }] });
      const { upsertDocument } = await import('../store.mjs');

      const id = await upsertDocument({
        businessId: 'demo-cafe',
        docType: 'summary',
        content: 'daily summary',
        embedding: [0.1, 0.2, 0.3],
      });

      expect(id).toBe('doc-1');
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('INSERT INTO documents');
      expect(params).toEqual(['demo-cafe', 'summary', null, 'daily summary', '{}', '[0.1,0.2,0.3]']);
    });

    it('upserts by id using UPSERT INTO when id is provided', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'doc-1' }] });
      const { upsertDocument } = await import('../store.mjs');

      await upsertDocument({
        id: 'doc-1',
        businessId: 'demo-cafe',
        docType: 'summary',
        content: 'updated summary',
        embedding: [0.4, 0.5],
      });

      const [sql] = queryMock.mock.calls[0];
      expect(sql).toContain('UPSERT INTO documents');
    });

    it('rejects an empty embedding', async () => {
      const { upsertDocument } = await import('../store.mjs');
      await expect(
        upsertDocument({ businessId: 'demo-cafe', docType: 'summary', content: 'x', embedding: [] })
      ).rejects.toThrow('embedding must be a non-empty number array');
    });

    it('re-embedding the same (business_id, doc_type, doc_date) updates the existing row instead of duplicating it', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [{ id: 'doc-existing' }] }) // natural-key lookup finds a row
        .mockResolvedValueOnce({ rows: [{ id: 'doc-existing' }] }); // UPSERT INTO by that id
      const { upsertDocument } = await import('../store.mjs');

      const id = await upsertDocument({
        businessId: 'demo-cafe',
        docType: 'daily_summary',
        docDate: '2026-07-04',
        content: 're-embedded summary',
        embedding: [0.9],
      });

      expect(id).toBe('doc-existing');
      expect(queryMock).toHaveBeenCalledTimes(2);
      const [lookupSql, lookupParams] = queryMock.mock.calls[0];
      expect(lookupSql).toContain('SELECT id FROM documents');
      expect(lookupParams).toEqual(['demo-cafe', 'daily_summary', '2026-07-04']);
      const [upsertSql, upsertParams] = queryMock.mock.calls[1];
      expect(upsertSql).toContain('UPSERT INTO documents');
      expect(upsertParams[0]).toBe('doc-existing');
    });

    it('a docDate with no existing row falls through to a fresh INSERT', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // natural-key lookup finds nothing
        .mockResolvedValueOnce({ rows: [{ id: 'doc-new' }] }); // plain INSERT
      const { upsertDocument } = await import('../store.mjs');

      const id = await upsertDocument({
        businessId: 'demo-cafe',
        docType: 'daily_summary',
        docDate: '2026-07-05',
        content: 'first embedding for this date',
        embedding: [0.5],
      });

      expect(id).toBe('doc-new');
      expect(queryMock).toHaveBeenCalledTimes(2);
      const [insertSql, insertParams] = queryMock.mock.calls[1];
      expect(insertSql).toContain('INSERT INTO documents');
      expect(insertParams).toEqual([
        'demo-cafe',
        'daily_summary',
        '2026-07-05',
        'first embedding for this date',
        '{}',
        '[0.5]',
      ]);
    });
  });

  describe('searchDocuments', () => {
    it('orders by cosine distance and maps rows to camelCase', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: 'doc-1',
            doc_type: 'summary',
            doc_date: null,
            content: 'cold brew sales',
            metadata: {},
            distance: 0.12,
          },
        ],
      });
      const { searchDocuments } = await import('../store.mjs');

      const results = await searchDocuments('demo-cafe', [0.1, 0.2], 5);

      expect(results).toEqual([
        {
          id: 'doc-1',
          docType: 'summary',
          docDate: null,
          content: 'cold brew sales',
          metadata: {},
          distance: 0.12,
        },
      ]);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('<=>');
      expect(params).toEqual(['demo-cafe', '[0.1,0.2]', 5]);
    });
  });

  describe('saveNote / listNotes / saveDraft', () => {
    it('saves a note and returns its id', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'note-1' }] });
      const { saveNote } = await import('../store.mjs');
      const id = await saveNote({ businessId: 'demo-cafe', content: 'owner prefers oat milk default' });
      expect(id).toBe('note-1');
    });

    it('lists notes for a business', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'note-1', content: 'x', source: null, created_at: new Date() }] });
      const { listNotes } = await import('../store.mjs');
      const notes = await listNotes('demo-cafe');
      expect(notes).toHaveLength(1);
      expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM notes'), ['demo-cafe']);
    });

    it('saves a draft with a JSON-stringified payload', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'draft-1' }] });
      const { saveDraft } = await import('../store.mjs');

      const id = await saveDraft({
        businessId: 'demo-cafe',
        kind: 'purchase_order',
        payload: { items: [{ name: 'milk', qty: 10 }] },
      });

      expect(id).toBe('draft-1');
      const [, params] = queryMock.mock.calls[0];
      expect(params[3]).toBe(JSON.stringify({ items: [{ name: 'milk', qty: 10 }] }));
    });
  });
});
