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

describe('memory/store.mjs & migrations', () => {
  const ORIGINAL_ENV = { ...process.env };
  const PRINCIPAL_AUTH = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'authenticated' };
  const PRINCIPAL_DEMO = { businessId: 'biz-1', actorId: 'demo-456', accessMode: 'demo' };
  const PRINCIPAL_LEGACY = { businessId: 'biz-1', actorId: 'legacy_demo', accessMode: 'legacy_demo' };

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

    await createConversation(PRINCIPAL_AUTH, { title: 't1' });
    await createConversation(PRINCIPAL_AUTH, { title: 't2' });

    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock).toHaveBeenCalledWith({ connectionString: process.env.CRDB_CONNECTION_STRING });
  });

  describe('migration ledger & runMigrations', () => {
    it('executes schema.sql and numbered migrations inside transactions using schema_migrations ledger', async () => {
      const client = { query: clientQueryMock };
      clientQueryMock.mockResolvedValue({ rows: [] });

      const { runMigrations } = await import('../migrate.mjs');
      await runMigrations({ client, embeddingDim: 1536 });

      expect(clientQueryMock).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations'));
      expect(clientQueryMock).toHaveBeenCalledWith('BEGIN');
      expect(clientQueryMock).toHaveBeenCalledWith('INSERT INTO schema_migrations (version) VALUES ($1)', ['001_principal_ownership.sql']);
      expect(clientQueryMock).toHaveBeenCalledWith('COMMIT');
    });

    it('throws error if reading migrations directory fails', async () => {
      const client = { query: clientQueryMock };
      const { runMigrations } = await import('../migrate.mjs');

      await expect(
        runMigrations({ client, embeddingDim: 1536, migrationsDir: '/nonexistent-migrations-dir' })
      ).rejects.toThrow(/Failed to read migrations directory/);
    });
  });

  describe('normalizePrincipal', () => {
    it('normalizes valid authenticated, demo, and legacy_demo principals', async () => {
      const { normalizePrincipal } = await import('../store.mjs');

      expect(normalizePrincipal(PRINCIPAL_AUTH)).toEqual(PRINCIPAL_AUTH);
      expect(normalizePrincipal(PRINCIPAL_DEMO)).toEqual(PRINCIPAL_DEMO);
      expect(normalizePrincipal(PRINCIPAL_LEGACY)).toEqual(PRINCIPAL_LEGACY);
    });

    it('rejects missing or blank businessId, actorId, and accessMode without implicit defaults', async () => {
      const { normalizePrincipal } = await import('../store.mjs');

      expect(() => normalizePrincipal(null)).toThrow('principal object is required');
      expect(() => normalizePrincipal({ businessId: '', actorId: 'u1', accessMode: 'authenticated' })).toThrow(
        'principal.businessId is required'
      );
      expect(() => normalizePrincipal({ businessId: 'b1', actorId: '', accessMode: 'authenticated' })).toThrow(
        'principal.actorId is required'
      );
      expect(() => normalizePrincipal({ businessId: 'b1', actorId: 'u1', accessMode: 'invalid' })).toThrow(
        /principal.accessMode must be/
      );
    });
  });

  describe('createConversation', () => {
    it('inserts conversation with principal fields and returns the new id', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
      const { createConversation } = await import('../store.mjs');

      const id = await createConversation(PRINCIPAL_AUTH, { title: 'chat title' });

      expect(id).toBe('conv-1');
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO conversations'),
        ['biz-1', 'user-100', 'authenticated', 'chat title']
      );
    });
  });

  describe('appendMessage & transaction handling', () => {
    it('runs INSERT...SELECT + UPDATE inside a transaction and commits', async () => {
      clientQueryMock
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] }) // INSERT...SELECT
        .mockResolvedValueOnce(undefined) // UPDATE conversations
        .mockResolvedValueOnce(undefined); // COMMIT

      const { appendMessage } = await import('../store.mjs');
      const id = await appendMessage(PRINCIPAL_AUTH, { conversationId: 'conv-1', role: 'user', content: 'hi' });

      expect(id).toBe('msg-1');
      expect(clientQueryMock).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(clientQueryMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO messages'),
        ['conv-1', 'user', 'hi', 'biz-1', 'user-100', 'authenticated']
      );
      expect(clientQueryMock).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('UPDATE conversations'),
        ['conv-1', 'biz-1', 'user-100', 'authenticated']
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
        appendMessage(PRINCIPAL_AUTH, { conversationId: 'conv-1', role: 'user', content: 'hi' })
      ).rejects.toThrow('insert failed');

      expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
      expect(releaseMock).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid role or blank content', async () => {
      const { appendMessage } = await import('../store.mjs');

      await expect(
        appendMessage(PRINCIPAL_AUTH, { conversationId: 'conv-1', role: 'system', content: 'hi' })
      ).rejects.toThrow("role must be 'user' or 'assistant'");

      await expect(
        appendMessage(PRINCIPAL_AUTH, { conversationId: 'conv-1', role: 'user', content: '   ' })
      ).rejects.toThrow('content is required');

      expect(connectMock).not.toHaveBeenCalled();
    });

    it('denies message append if conversation belongs to another actor or business', async () => {
      clientQueryMock
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // 0 rows inserted by predicate
        .mockResolvedValueOnce(undefined); // ROLLBACK

      const { appendMessage } = await import('../store.mjs');
      const foreignPrincipal = { businessId: 'biz-1', actorId: 'user-other', accessMode: 'authenticated' };

      await expect(
        appendMessage(foreignPrincipal, { conversationId: 'conv-1', role: 'user', content: 'hack' })
      ).rejects.toThrow('Access denied or conversation not found');

      expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('getRecentMessages & cross-principal denial', () => {
    it('returns messages oldest-first when principal owns the conversation', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          { role: 'assistant', content: 'second', created_at: new Date('2026-01-01T00:00:02Z') },
          { role: 'user', content: 'first', created_at: new Date('2026-01-01T00:00:01Z') },
        ],
      });
      const { getRecentMessages } = await import('../store.mjs');

      const result = await getRecentMessages(PRINCIPAL_AUTH, 'conv-1', 12);

      expect(result.map((m) => m.content)).toEqual(['first', 'second']);
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('JOIN conversations c ON m.conversation_id = c.id'),
        ['conv-1', 'biz-1', 'user-100', 'authenticated', 12]
      );
    });

    it('returns empty array when conversation belongs to another principal', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { getRecentMessages } = await import('../store.mjs');

      const foreignPrincipal = { businessId: 'biz-2', actorId: 'user-100', accessMode: 'authenticated' };
      const messages = await getRecentMessages(foreignPrincipal, 'conv-1');

      expect(messages).toEqual([]);
    });
  });

  describe('saveDraft & foreign conversation denial', () => {
    it('saves a draft with conversationId when principal owns the conversation', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'draft-1' }] });
      const { saveDraft } = await import('../store.mjs');

      const id = await saveDraft(PRINCIPAL_AUTH, {
        conversationId: 'conv-1',
        kind: 'purchase_order',
        payload: { item: 'milk' },
      });

      expect(id).toBe('draft-1');
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('INSERT INTO drafts');
      expect(sql).toContain('FROM conversations');
      expect(params).toEqual([
        'biz-1',
        'user-100',
        'authenticated',
        'purchase_order',
        '{"item":"milk"}',
        'conv-1',
      ]);
    });

    it('rejects draft creation if referenced conversation is foreign to the principal', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { saveDraft } = await import('../store.mjs');

      const foreignPrincipal = { businessId: 'biz-1', actorId: 'user-hacker', accessMode: 'authenticated' };

      await expect(
        saveDraft(foreignPrincipal, {
          conversationId: 'conv-owned-by-user-100',
          kind: 'purchase_order',
          payload: { item: 'coffee' },
        })
      ).rejects.toThrow('Access denied or invalid conversationId for draft');
    });
  });

  describe('saveNote & listNotes', () => {
    it('stores created_by from principal actorId when saving notes', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'note-1' }] });
      const { saveNote } = await import('../store.mjs');

      const id = await saveNote(PRINCIPAL_AUTH, { content: 'oat milk note' });

      expect(id).toBe('note-1');
      const [, params] = queryMock.mock.calls[0];
      expect(params).toEqual(['biz-1', 'user-100', 'user-100', 'authenticated', 'oat milk note', null]);
    });

    it('lists notes for a business carrying created_by', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ id: 'note-1', content: 'note content', created_by: 'user-100', created_at: new Date() }],
      });
      const { listNotes } = await import('../store.mjs');

      const notes = await listNotes(PRINCIPAL_AUTH);
      expect(notes).toHaveLength(1);
      expect(notes[0].created_by).toBe('user-100');
    });
  });

  describe('upsertDocument & document security', () => {
    it('inserts a new undated document with bracketed vector literal', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'doc-1' }] });
      const { upsertDocument } = await import('../store.mjs');

      const id = await upsertDocument(PRINCIPAL_AUTH, {
        docType: 'summary',
        content: 'daily summary',
        embedding: [0.1, 0.2, 0.3],
      });

      expect(id).toBe('doc-1');
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('INSERT INTO documents');
      expect(params).toEqual(['biz-1', 'user-100', 'summary', 'daily summary', '{}', '[0.1,0.2,0.3]']);
    });

    it('updates document with explicit ID only WHERE id = ? AND business_id = ? without overwriting created_by', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'doc-1' }] });
      const { upsertDocument } = await import('../store.mjs');

      await upsertDocument(PRINCIPAL_AUTH, {
        id: 'doc-1',
        docType: 'summary',
        content: 'updated content',
        embedding: [0.4, 0.5],
      });

      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('UPDATE documents');
      expect(sql).not.toContain('created_by =');
      expect(params).toEqual(['doc-1', 'biz-1', 'summary', null, 'updated content', '{}', '[0.4,0.5]']);
    });

    it('rejects caller-provided ID update if document belongs to another business', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] }); // 0 rows updated
      const { upsertDocument } = await import('../store.mjs');

      const foreignPrincipal = { businessId: 'biz-other', actorId: 'user-100', accessMode: 'authenticated' };

      await expect(
        upsertDocument(foreignPrincipal, {
          id: 'doc-1',
          docType: 'summary',
          content: 'hack',
          embedding: [0.1],
        })
      ).rejects.toThrow('Access denied or document not found');
    });

    it('uses ON CONFLICT (business_id, doc_type, doc_date) for dated documents atomically without SELECT-then-UPSERT race', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'doc-dated-1' }] });
      const { upsertDocument } = await import('../store.mjs');

      const id = await upsertDocument(PRINCIPAL_AUTH, {
        docType: 'daily_summary',
        docDate: '2026-07-04',
        content: 'dated content',
        embedding: [0.9],
      });

      expect(id).toBe('doc-dated-1');
      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (business_id, doc_type, doc_date)');
      expect(params).toEqual(['biz-1', 'user-100', 'daily_summary', '2026-07-04', 'dated content', '{}', '[0.9]']);
    });

    it('rejects empty or non-array embedding', async () => {
      const { upsertDocument } = await import('../store.mjs');
      await expect(
        upsertDocument(PRINCIPAL_AUTH, { docType: 'summary', content: 'x', embedding: [] })
      ).rejects.toThrow('embedding must be a non-empty number array');
    });
  });

  describe('searchDocuments', () => {
    it('vector searches using cosine operator <=> filtered by business_id', async () => {
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

      const results = await searchDocuments(PRINCIPAL_AUTH, [0.1, 0.2], 5);

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
      expect(params).toEqual(['biz-1', '[0.1,0.2]', 5]);
    });
  });
});
