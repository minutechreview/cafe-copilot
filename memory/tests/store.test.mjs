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
    expect(PoolMock).toHaveBeenCalledWith({
      connectionString: process.env.CRDB_CONNECTION_STRING,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      query_timeout: 10000,
      statement_timeout: 10000,
    });
  });

  it('uses validated bounded pool settings from server environment variables', async () => {
    process.env.CRDB_POOL_MAX = '3';
    process.env.CRDB_CONNECTION_TIMEOUT_MS = '2500';
    process.env.CRDB_IDLE_TIMEOUT_MS = '15000';
    process.env.CRDB_QUERY_TIMEOUT_MS = '8000';
    process.env.CRDB_STATEMENT_TIMEOUT_MS = '9000';
    const { getPoolOptions } = await import('../store.mjs');

    expect(getPoolOptions()).toEqual({
      connectionString: process.env.CRDB_CONNECTION_STRING,
      max: 3,
      connectionTimeoutMillis: 2500,
      idleTimeoutMillis: 15000,
      query_timeout: 8000,
      statement_timeout: 9000,
    });
  });

  it('fails closed for invalid bounded pool configuration before creating a pool', async () => {
    process.env.CRDB_POOL_MAX = '11';
    const { createConversation } = await import('../store.mjs');

    await expect(createConversation(PRINCIPAL_AUTH, { title: 't' })).rejects.toThrow(
      'CRDB_POOL_MAX must be a positive integer no greater than 10'
    );
    expect(PoolMock).not.toHaveBeenCalled();
  });

  describe('splitSqlStatements utility', () => {
    it('splits SQL content on semicolons, strips comments, and preserves multi-line statements', async () => {
      const { splitSqlStatements } = await import('../migrate.mjs');

      const rawSql = `
        -- Header comment line
        CREATE TABLE conversations (
          id UUID PRIMARY KEY, -- inline comment
          title TEXT
        );

        -- Section break comment
        ALTER TABLE conversations
          ADD COLUMN actor_id TEXT;
      `;

      const statements = splitSqlStatements(rawSql);

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain('CREATE TABLE conversations');
      expect(statements[0]).not.toContain('-- Header comment line');
      expect(statements[0]).not.toContain('-- inline comment');
      expect(statements[1]).toContain('ALTER TABLE conversations');
      expect(statements[1]).toContain('ADD COLUMN actor_id TEXT');
    });
  });

  describe('migration ledger, preflight checks & zero-padded filenames', () => {
    it('discovers 001 is pending with zero mutations, runs preflight checks BEFORE any DDL, and applies 001 migration as individual statements', async () => {
      const client = { query: clientQueryMock };
      clientQueryMock
        .mockResolvedValueOnce({ rows: [{ rel: null }] }) // to_regclass schema_migrations
        .mockResolvedValueOnce({ rows: [{ rel: 'drafts' }] }) // to_regclass drafts
        .mockResolvedValueOnce({ rows: [{ rel: 'documents' }] }) // to_regclass docs
        .mockResolvedValue({ rows: [] });

      const { runMigrations } = await import('../migrate.mjs');
      await runMigrations({ client, embeddingDim: 1536 });

      // First query must be read-only to_regclass for schema_migrations pending discovery
      expect(clientQueryMock).toHaveBeenNthCalledWith(1, expect.stringContaining("to_regclass('public.schema_migrations')"));
      expect(clientQueryMock).toHaveBeenNthCalledWith(2, expect.stringContaining("to_regclass('public.drafts')"));
      expect(clientQueryMock).toHaveBeenNthCalledWith(3, expect.stringContaining("to_regclass('public.documents')"));
      expect(clientQueryMock).toHaveBeenNthCalledWith(4, expect.stringContaining('FROM drafts d'));
      expect(clientQueryMock).toHaveBeenNthCalledWith(5, expect.stringContaining('FROM documents'));
      // Sixth query is the FIRST mutation (CREATE TABLE schema_migrations)
      expect(clientQueryMock).toHaveBeenNthCalledWith(6, expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations'));

      // Verify individual SQL statements were issued per client.query call
      const sqlCalls = clientQueryMock.mock.calls.map((c) => String(c[0]));
      expect(sqlCalls.some((sql) => sql.includes('ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_conversation_fk'))).toBe(true);
      expect(sqlCalls.some((sql) => sql.includes('ADD CONSTRAINT conversations_id_business_actor_mode_key'))).toBe(true);

      // Final call is the ledger write
      expect(clientQueryMock).toHaveBeenLastCalledWith(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        ['001_principal_ownership.sql']
      );
    });

    it('proves ZERO SQL mutation (CREATE TABLE, BEGIN, INSERT, UPDATE, ALTER) precedes a failing preflight', async () => {
      const client = { query: clientQueryMock };
      clientQueryMock
        .mockResolvedValueOnce({ rows: [{ rel: null }] }) // to_regclass schema_migrations (read-only)
        .mockResolvedValueOnce({ rows: [{ rel: 'drafts' }] }) // to_regclass drafts (read-only)
        .mockResolvedValueOnce({ rows: [{ rel: 'documents' }] }) // to_regclass docs (read-only)
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // preflight drafts
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }); // preflight docs finds 3 duplicate dated doc groups!

      const { runMigrations } = await import('../migrate.mjs');
      await expect(runMigrations({ client, embeddingDim: 1536 })).rejects.toThrow(
        /Preflight check failed: found 0 invalid draft\(s\).*and 3 duplicate dated document group\(s\)/
      );

      const mutationVerbs = ['CREATE', 'BEGIN', 'INSERT', 'UPDATE', 'ALTER', 'DELETE', 'DROP'];
      for (const call of clientQueryMock.mock.calls) {
        const sql = String(call[0]).trim().toUpperCase();
        for (const verb of mutationVerbs) {
          expect(sql.startsWith(verb)).toBe(false);
        }
      }
    });

    it('proves statement failure prevents ledger write, and resume completes safely', async () => {
      const client = { query: clientQueryMock };
      // Simulate statement error on 10th query
      let queryCount = 0;
      clientQueryMock.mockImplementation(() => {
        queryCount += 1;
        if (queryCount === 10) {
          return Promise.reject(new Error('CockroachDB transient execution error'));
        }
        return Promise.resolve({ rows: [] });
      });

      const { runMigrations } = await import('../migrate.mjs');
      await expect(runMigrations({ client, embeddingDim: 1536 })).rejects.toThrow(
        'CockroachDB transient execution error'
      );

      // Verify ledger write was NOT performed when statement 10 failed
      expect(clientQueryMock).not.toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        ['001_principal_ownership.sql']
      );

      // Now retry runMigrations (resumable/idempotent check)
      clientQueryMock.mockReset();
      clientQueryMock.mockResolvedValue({ rows: [] });
      await runMigrations({ client, embeddingDim: 1536 });

      expect(clientQueryMock).toHaveBeenLastCalledWith(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        ['001_principal_ownership.sql']
      );
    });

    it('skips preflight checks when 001 migration has already been applied', async () => {
      const client = { query: clientQueryMock };
      clientQueryMock
        .mockResolvedValueOnce({ rows: [{ rel: 'schema_migrations' }] })
        .mockResolvedValueOnce({ rows: [{ version: '001_principal_ownership.sql' }] })
        .mockResolvedValue({ rows: [{ version: '001_principal_ownership.sql' }] });

      const { runMigrations } = await import('../migrate.mjs');
      await runMigrations({ client, embeddingDim: 1536 });

      expect(clientQueryMock).not.toHaveBeenCalledWith(expect.stringContaining('FROM drafts d'));
    });
  });

  describe('normalizePrincipal & missing-principal validation across all store APIs', () => {
    it('normalizes valid authenticated, demo, and legacy_demo principals', async () => {
      const { normalizePrincipal } = await import('../store.mjs');

      expect(normalizePrincipal(PRINCIPAL_AUTH)).toEqual(PRINCIPAL_AUTH);
      expect(normalizePrincipal(PRINCIPAL_DEMO)).toEqual(PRINCIPAL_DEMO);
      expect(normalizePrincipal(PRINCIPAL_LEGACY)).toEqual(PRINCIPAL_LEGACY);
    });

    it('rejects missing principal or missing fields across every store API', async () => {
      const store = await import('../store.mjs');

      const apis = [
        () => store.createConversation(null, { title: 't' }),
        () => store.appendMessage(null, { conversationId: 'c1', role: 'user', content: 'hi' }),
        () => store.getRecentMessages(null, 'c1'),
        () => store.saveNote(null, { content: 'note' }),
        () => store.listNotes(null),
        () => store.saveDraft(null, { kind: 'po', payload: {} }),
        () => store.upsertDocument(null, { docType: 'doc', content: 'c', embedding: [0.1] }),
        () => store.searchDocuments(null, [0.1]),
      ];

      for (const apiCall of apis) {
        await expect(apiCall()).rejects.toThrow('principal object is required');
      }
    });

    it('rejects invalid accessMode across store APIs', async () => {
      const store = await import('../store.mjs');
      const invalidPrincipal = { businessId: 'biz-1', actorId: 'u1', accessMode: 'invalid' };

      await expect(store.createConversation(invalidPrincipal, { title: 't' })).rejects.toThrow(
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

    it('destroys the connection and never commits when an in-flight write is aborted', async () => {
      const controller = new AbortController();
      let finishInsert;
      clientQueryMock
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => new Promise((resolve) => { finishInsert = resolve; }));

      const { appendMessage } = await import('../store.mjs');
      const pending = appendMessage(
        PRINCIPAL_AUTH,
        { conversationId: 'conv-1', role: 'user', content: 'hi' },
        { signal: controller.signal }
      );
      await vi.waitFor(() => expect(clientQueryMock).toHaveBeenCalledTimes(2));

      controller.abort();
      expect(releaseMock).toHaveBeenCalledWith(true);
      finishInsert({ rows: [{ id: 'msg-1' }] });
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      expect(clientQueryMock.mock.calls.some(([arg]) => arg === 'COMMIT')).toBe(false);
      expect(clientQueryMock).toHaveBeenCalledTimes(2);
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

    it('denies message append if conversation belongs to another accessMode or actor', async () => {
      clientQueryMock
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // 0 rows inserted by predicate
        .mockResolvedValueOnce(undefined); // ROLLBACK

      const { appendMessage } = await import('../store.mjs');
      const foreignModePrincipal = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'demo' };

      await expect(
        appendMessage(foreignModePrincipal, { conversationId: 'conv-1', role: 'user', content: 'hack' })
      ).rejects.toThrow('Access denied or conversation not found');

      expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('getRecentMessages & cross-principal denial', () => {
    it('destroys the dedicated connection when a read is aborted in flight', async () => {
      const controller = new AbortController();
      let finishRead;
      clientQueryMock.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
      const { getRecentMessages } = await import('../store.mjs');
      const pending = getRecentMessages(PRINCIPAL_AUTH, 'conv-1', 12, { signal: controller.signal });
      await vi.waitFor(() => expect(clientQueryMock).toHaveBeenCalledTimes(1));

      controller.abort();
      expect(releaseMock).toHaveBeenCalledWith(true);
      finishRead({ rows: [{ role: 'user', content: 'late', created_at: new Date() }] });

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('checks exact conversation ownership even when the conversation has no messages', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ owned: true }] });
      const { conversationExists } = await import('../store.mjs');

      await expect(conversationExists(PRINCIPAL_AUTH, 'conv-empty')).resolves.toBe(true);
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('AND actor_id = $3'),
        ['conv-empty', 'biz-1', 'user-100', 'authenticated']
      );
    });

    it('returns false for stale or foreign actor/business/mode conversation ids', async () => {
      queryMock.mockResolvedValue({ rows: [{ owned: false }] });
      const { conversationExists } = await import('../store.mjs');

      await expect(conversationExists(PRINCIPAL_AUTH, 'foreign')).resolves.toBe(false);
      expect(queryMock.mock.calls[0][0]).toContain('business_id = $2');
      expect(queryMock.mock.calls[0][0]).toContain('actor_id = $3');
      expect(queryMock.mock.calls[0][0]).toContain('access_mode = $4');
    });

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

    it('returns empty array when conversation belongs to another accessMode or actor', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { getRecentMessages } = await import('../store.mjs');

      const foreignPrincipal = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'demo' };
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

    it('rejects draft creation if referenced conversation belongs to another accessMode', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { saveDraft } = await import('../store.mjs');

      const foreignModePrincipal = { businessId: 'biz-1', actorId: 'user-100', accessMode: 'demo' };

      await expect(
        saveDraft(foreignModePrincipal, {
          conversationId: 'conv-owned-by-authenticated-user-100',
          kind: 'purchase_order',
          payload: { item: 'coffee' },
        })
      ).rejects.toThrow('Access denied or invalid conversationId for draft');
    });
  });

  describe('saveNote & listNotes (business-shared)', () => {
    it('stores created_by from principal actorId when saving notes', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'note-1' }] });
      const { saveNote } = await import('../store.mjs');

      const id = await saveNote(PRINCIPAL_AUTH, { content: 'oat milk note' });

      expect(id).toBe('note-1');
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('INSERT INTO notes (business_id, created_by, content, source)');
      expect(params).toEqual(['biz-1', 'user-100', 'oat milk note', null]);
    });

    it('lists authenticated business notes while excluding demo-session notes', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ id: 'note-1', content: 'note content', created_by: 'user-100', created_at: new Date() }],
      });
      const { listNotes } = await import('../store.mjs');

      const notes = await listNotes(PRINCIPAL_AUTH);
      expect(notes).toHaveLength(1);
      expect(notes[0].created_by).toBe('user-100');
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain("created_by NOT LIKE 'demo-session-%'");
      expect(sql).toContain("created_by <> 'legacy_demo'");
      expect(params).toEqual(['biz-1']);
    });

    it('isolates demo note listing to the exact demo-session actor', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'own-note', created_by: PRINCIPAL_DEMO.actorId }] });
      const { listNotes } = await import('../store.mjs');

      const notes = await listNotes(PRINCIPAL_DEMO);

      expect(notes).toEqual([{ id: 'own-note', created_by: PRINCIPAL_DEMO.actorId }]);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('created_by = $2');
      expect(params).toEqual(['biz-1', 'demo-456']);
    });

    it('stores separate immutable created_by identities for two demo sessions', async () => {
      queryMock.mockResolvedValue({ rows: [{ id: 'note-demo' }] });
      const { saveNote } = await import('../store.mjs');
      const otherDemo = { ...PRINCIPAL_DEMO, actorId: 'demo-other' };

      await saveNote(PRINCIPAL_DEMO, { content: 'mine' });
      await saveNote(otherDemo, { content: 'theirs' });

      expect(queryMock.mock.calls[0][1][1]).toBe('demo-456');
      expect(queryMock.mock.calls[1][1][1]).toBe('demo-other');
    });
  });

  it('starts no memory write when the request signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const store = await import('../store.mjs');

    await expect(store.createConversation(PRINCIPAL_AUTH, {}, { signal: controller.signal })).rejects.toThrow(
      'Request deadline exceeded'
    );
    await expect(store.saveNote(PRINCIPAL_AUTH, { content: 'nope' }, { signal: controller.signal })).rejects.toThrow(
      'Request deadline exceeded'
    );
    await expect(
      store.saveDraft(PRINCIPAL_AUTH, { kind: 'purchase_order', payload: {} }, { signal: controller.signal })
    ).rejects.toThrow('Request deadline exceeded');
    expect(queryMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
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
