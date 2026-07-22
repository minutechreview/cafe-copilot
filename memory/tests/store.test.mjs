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

  describe('migration idempotence & schema rendering', () => {
    it('renders schema and migration files cleanly with EMBEDDING_DIM placeholder substitution', async () => {
      const { renderSchema } = await import('../migrate.mjs');
      const sql = renderSchema({ embeddingDim: 1024 });

      expect(sql).toContain('VECTOR(1024)');
      expect(sql).not.toContain('__EMBEDDING_DIM__');
      expect(sql).toContain('actor_id TEXT');
      expect(sql).toContain('access_mode TEXT NOT NULL DEFAULT \'legacy_demo\'');
      expect(sql).toContain('UPDATE conversations SET access_mode = \'legacy_demo\'');
    });
  });

  describe('normalizePrincipal', () => {
    it('normalizes valid authenticated, demo, and legacy_demo principals', async () => {
      const { normalizePrincipal } = await import('../store.mjs');

      expect(
        normalizePrincipal({ businessId: 'biz-1', actorId: 'user-123', accessMode: 'authenticated' })
      ).toEqual({ businessId: 'biz-1', actorId: 'user-123', accessMode: 'authenticated' });

      expect(
        normalizePrincipal({ businessId: 'biz-1', actorId: 'demo-session-456', accessMode: 'demo' })
      ).toEqual({ businessId: 'biz-1', actorId: 'demo-session-456', accessMode: 'demo' });

      expect(normalizePrincipal({ businessId: 'biz-1' })).toEqual({
        businessId: 'biz-1',
        actorId: 'legacy_demo',
        accessMode: 'legacy_demo',
      });
    });

    it('rejects invalid or missing principals and missing actorIds in active modes', async () => {
      const { normalizePrincipal } = await import('../store.mjs');

      expect(() => normalizePrincipal(null)).toThrow('principal object is required');
      expect(() => normalizePrincipal({ businessId: '' })).toThrow('businessId is required');
      expect(() => normalizePrincipal({ businessId: 'biz-1', accessMode: 'invalid' })).toThrow(
        /accessMode must be/
      );
      expect(() => normalizePrincipal({ businessId: 'biz-1', accessMode: 'authenticated' })).toThrow(
        'actorId is required for authenticated or demo accessMode'
      );
    });
  });

  describe('createConversation', () => {
    it('inserts conversation with principal fields and returns the new id', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
      const { createConversation } = await import('../store.mjs');

      const principal = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'authenticated' };
      const id = await createConversation(principal, { title: 'chat title' });

      expect(id).toBe('conv-1');
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO conversations'),
        ['biz-1', 'user-100', 'authenticated', 'chat title']
      );
    });
  });

  describe('appendMessage & cross-principal denial', () => {
    it('appends message using atomic INSERT...SELECT predicate when principal matches', async () => {
      clientQueryMock
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] }) // INSERT...SELECT
        .mockResolvedValueOnce(undefined) // UPDATE conversations
        .mockResolvedValueOnce(undefined); // COMMIT

      const { appendMessage } = await import('../store.mjs');
      const principal = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'authenticated' };
      const id = await appendMessage(principal, { conversationId: 'conv-1', role: 'user', content: 'hi' });

      expect(id).toBe('msg-1');
      const [, params] = clientQueryMock.mock.calls[1];
      expect(params).toEqual(['conv-1', 'user', 'hi', 'biz-1', 'user-100', 'authenticated']);
    });

    it('denies message append if conversation belongs to another actor or business without revealing existence', async () => {
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
    it('returns messages when principal owns the conversation', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ role: 'user', content: 'hello', created_at: new Date() }],
      });
      const { getRecentMessages } = await import('../store.mjs');

      const principal = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'authenticated' };
      const messages = await getRecentMessages(principal, 'conv-1');

      expect(messages).toHaveLength(1);
      const [, params] = queryMock.mock.calls[0];
      expect(params).toEqual(['conv-1', 'biz-1', 'user-100', 'authenticated', 12]);
    });

    it('rejects access when conversationId is passed without principal', async () => {
      const { getRecentMessages } = await import('../store.mjs');
      await expect(getRecentMessages('conv-1')).rejects.toThrow('principal is required');
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

      const principal = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'authenticated' };
      const id = await saveDraft(principal, {
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
      queryMock.mockResolvedValueOnce({ rows: [] }); // 0 rows inserted by predicate query
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

      const principal = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'authenticated' };
      const id = await saveNote(principal, { content: 'oat milk note' });

      expect(id).toBe('note-1');
      const [, params] = queryMock.mock.calls[0];
      expect(params).toEqual(['biz-1', 'user-100', 'authenticated', 'user-100', 'oat milk note', null]);
    });

    it('lists notes for a business carrying created_by', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ id: 'note-1', content: 'note content', created_by: 'user-100', created_at: new Date() }],
      });
      const { listNotes } = await import('../store.mjs');

      const notes = await listNotes({ businessId: 'biz-1' });
      expect(notes).toHaveLength(1);
      expect(notes[0].created_by).toBe('user-100');
    });
  });
});
