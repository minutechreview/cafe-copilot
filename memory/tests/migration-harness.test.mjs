import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * SQL State Machine Engine for non-mock migration rehearsal.
 * Evaluates DDL and DML statements against an in-memory relational schema state.
 */
class InMemoryDatabaseHarness {
  constructor() {
    this.tables = new Map();
    this.ledger = new Set();
    this.queries = [];
    this.preMigrationPrincipalShape = null;
  }

  hasTable(tableName) {
    return this.tables.has(tableName);
  }

  getTable(tableName) {
    if (!this.tables.has(tableName)) {
      this.createTable(tableName);
    }
    return this.tables.get(tableName);
  }

  hasColumn(tableName, columnName) {
    return this.hasTable(tableName) && this.getTable(tableName).columns.has(columnName);
  }

  createTable(tableName, columns = [], constraints = []) {
    if (this.tables.has(tableName)) {
      // CREATE TABLE IF NOT EXISTS is a catalog no-op for an existing table.
      // In particular, it must not add new principal columns to legacy tables.
      return;
    }
    this.tables.set(tableName, {
      name: tableName,
      columns: new Map(columns.map((c) => [c.name, c])),
      constraints: [...constraints],
      rows: [],
    });
  }

  addColumn(tableName, columnName, type, isNullable = true, defaultValue = null) {
    const table = this.getTable(tableName);
    if (!table.columns.has(columnName)) {
      table.columns.set(columnName, { name: columnName, type, isNullable, defaultValue });
    }
    for (const row of table.rows) {
      if (row[columnName] === undefined || row[columnName] === null) {
        row[columnName] = defaultValue;
      }
    }
  }

  dropConstraint(tableName, constraintName) {
    const table = this.getTable(tableName);
    table.constraints = table.constraints.filter((c) => c.name !== constraintName);
  }

  addConstraint(tableName, constraintName, type, details) {
    const table = this.getTable(tableName);
    table.constraints.push({ name: constraintName, type, details });
  }

  insert(tableName, row) {
    const table = this.getTable(tableName);
    const fullRow = {};
    for (const [colName, colMeta] of table.columns.entries()) {
      fullRow[colName] = row[colName] !== undefined ? row[colName] : colMeta.defaultValue;
    }
    // Also retain extra fields in row
    for (const key of Object.keys(row)) {
      if (!(key in fullRow)) {
        fullRow[key] = row[key];
      }
    }
    table.rows.push(fullRow);
    return fullRow;
  }

  update(tableName, setter, predicate = () => true) {
    const table = this.getTable(tableName);
    let count = 0;
    for (const row of table.rows) {
      if (predicate(row)) {
        setter(row);
        count += 1;
      }
    }
    return count;
  }

  query(sql, params = []) {
    this.queries.push(sql.trim());
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('--'));

    let lastResult = { rows: [] };
    for (const stmt of statements) {
      lastResult = this.execStatement(stmt, params);
    }
    return lastResult;
  }

  execStatement(text, params = []) {
    const upper = text.toUpperCase();

    // 1. to_regclass queries
    if (upper.includes('TO_REGCLASS')) {
      if (upper.includes('SCHEMA_MIGRATIONS')) {
        return { rows: [{ rel: this.hasTable('schema_migrations') ? 'schema_migrations' : null }] };
      }
      if (upper.includes('DRAFTS')) {
        return { rows: [{ rel: this.hasTable('drafts') ? 'drafts' : null }] };
      }
      if (upper.includes('DOCUMENTS')) {
        return { rows: [{ rel: this.hasTable('documents') ? 'documents' : null }] };
      }
      return { rows: [{ rel: null }] };
    }

    // 2. Preflight invalid drafts count
    if (upper.includes('FROM DRAFTS D') && upper.includes('LEFT JOIN CONVERSATIONS C')) {
      const drafts = this.hasTable('drafts') ? this.getTable('drafts').rows : [];
      const convs = this.hasTable('conversations') ? this.getTable('conversations').rows : [];
      const invalid = drafts.filter((d) => {
        if (!d.conversation_id) return false;
        const conv = convs.find((c) => c.id === d.conversation_id);
        return !conv || d.business_id !== conv.business_id;
      });
      return { rows: [{ count: invalid.length }] };
    }

    // 3. Preflight duplicate dated documents count
    if (upper.includes('FROM DOCUMENTS') && upper.includes('GROUP BY BUSINESS_ID, DOC_TYPE, DOC_DATE')) {
      const docs = this.hasTable('documents')
        ? this.getTable('documents').rows.filter((d) => d.doc_date !== null && d.doc_date !== undefined)
        : [];
      const groups = new Map();
      for (const d of docs) {
        const key = `${d.business_id}:${d.doc_type}:${d.doc_date}`;
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      let dupes = 0;
      for (const count of groups.values()) {
        if (count > 1) dupes += 1;
      }
      return { rows: [{ count: dupes }] };
    }

    // 4. Check schema_migrations version
    if (upper.includes('SELECT VERSION FROM SCHEMA_MIGRATIONS WHERE VERSION =')) {
      const version = params[0];
      return { rows: this.ledger.has(version) ? [{ version }] : [] };
    }

    // 5. CREATE TABLE schema_migrations
    if (upper.includes('CREATE TABLE IF NOT EXISTS SCHEMA_MIGRATIONS')) {
      this.createTable('schema_migrations', [{ name: 'version' }, { name: 'applied_at' }]);
      return { rows: [] };
    }

    // 6. INSERT schema_migrations
    if (upper.includes('INSERT INTO SCHEMA_MIGRATIONS')) {
      const version = params[0];
      if (version) {
        this.ledger.add(version);
        this.insert('schema_migrations', { version, applied_at: new Date().toISOString() });
      }
      return { rows: [] };
    }

    // 7. Base table bootstrap simulation. CREATE TABLE IF NOT EXISTS must not
    // evolve an existing legacy table; migration 001 owns that evolution.
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+CONVERSATIONS\b/i.test(text)) {
      this.createTable('conversations', [
        { name: 'id' },
        { name: 'business_id' },
        { name: 'actor_id', defaultValue: 'legacy_demo' },
        { name: 'access_mode', defaultValue: 'legacy_demo' },
        { name: 'title' },
      ]);
    }
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+MESSAGES\b/i.test(text)) {
      this.createTable('messages', [
        { name: 'id' },
        { name: 'conversation_id' },
        { name: 'role' },
        { name: 'content' },
      ]);
    }
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+NOTES\b/i.test(text)) {
      this.createTable('notes', [
        { name: 'id' },
        { name: 'business_id' },
        { name: 'created_by', defaultValue: 'legacy_demo' },
        { name: 'content' },
      ]);
    }
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+DRAFTS\b/i.test(text)) {
      this.createTable('drafts', [
        { name: 'id' },
        { name: 'business_id' },
        { name: 'actor_id', defaultValue: 'legacy_demo' },
        { name: 'access_mode', defaultValue: 'legacy_demo' },
        { name: 'conversation_id' },
      ]);
    }
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+DOCUMENTS\b/i.test(text)) {
      this.createTable('documents', [
        { name: 'id' },
        { name: 'business_id' },
        { name: 'created_by', defaultValue: 'system' },
        { name: 'doc_type' },
        { name: 'doc_date' },
      ]);
    }

    // This deliberately rejects the live failure mode: an index may not refer
    // to a principal column until migration 001 has added it to a legacy table.
    if (/^CREATE\s+(?:UNIQUE\s+|VECTOR\s+)?INDEX\b/i.test(text)) {
      const indexedTable = text.match(/\bON\s+(conversations|drafts)\s*\(/i)?.[1]?.toLowerCase();
      if (indexedTable && (!this.hasColumn(indexedTable, 'actor_id') || !this.hasColumn(indexedTable, 'access_mode'))) {
        throw new Error(`cannot create principal index on legacy ${indexedTable} without principal columns`);
      }
    }

    // 8. Migration 001 execution simulation
    if (/^ALTER\s+TABLE\s+DRAFTS\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+DRAFTS_CONVERSATION_FK\b/i.test(text)) {
      this.preMigrationPrincipalShape = {
        conversations: {
          actorId: this.hasColumn('conversations', 'actor_id'),
          accessMode: this.hasColumn('conversations', 'access_mode'),
        },
        drafts: {
          actorId: this.hasColumn('drafts', 'actor_id'),
          accessMode: this.hasColumn('drafts', 'access_mode'),
        },
        notes: { createdBy: this.hasColumn('notes', 'created_by') },
        documents: { createdBy: this.hasColumn('documents', 'created_by') },
      };
    }
    if (/^ALTER\s+TABLE\s+CONVERSATIONS\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+ACTOR_ID\b/i.test(text)) {
      this.addColumn('conversations', 'actor_id', 'TEXT', false, 'legacy_demo');
    }
    if (/^ALTER\s+TABLE\s+CONVERSATIONS\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+ACCESS_MODE\b/i.test(text)) {
      this.addColumn('conversations', 'access_mode', 'TEXT', false, 'legacy_demo');
    }
    if (/^ALTER\s+TABLE\s+DRAFTS\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+ACTOR_ID\b/i.test(text)) {
      this.addColumn('drafts', 'actor_id', 'TEXT', false, 'legacy_demo');
    }
    if (/^ALTER\s+TABLE\s+DRAFTS\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+ACCESS_MODE\b/i.test(text)) {
      this.addColumn('drafts', 'access_mode', 'TEXT', false, 'legacy_demo');
    }
    if (upper.includes('UPDATE CONVERSATIONS')) {
      this.update('conversations', (row) => {
        row.actor_id = row.actor_id || 'legacy_demo';
        row.access_mode = row.access_mode || 'legacy_demo';
      });
    }
    if (upper.includes('UPDATE DRAFTS')) {
      this.update('drafts', (row) => {
        row.actor_id = row.actor_id || 'legacy_demo';
        row.access_mode = row.access_mode || 'legacy_demo';
      });
    }
    if (upper.includes('DROP CONSTRAINT IF EXISTS DRAFTS_CONVERSATION_FK')) {
      if (this.hasTable('drafts')) {
        this.dropConstraint('drafts', 'drafts_conversation_fk');
      }
    }
    if (upper.includes('ADD CONSTRAINT CONVERSATIONS_ID_BUSINESS_ACTOR_MODE_KEY')) {
      this.addConstraint('conversations', 'conversations_id_business_actor_mode_key', 'UNIQUE', [
        'id',
        'business_id',
        'actor_id',
        'access_mode',
      ]);
    }
    if (upper.includes('ADD CONSTRAINT DRAFTS_CONVERSATION_FK')) {
      this.addConstraint('drafts', 'drafts_conversation_fk', 'FOREIGN KEY', ['conversation_id']);
    }
    if (/^ALTER\s+TABLE\s+NOTES\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+CREATED_BY\b/i.test(text)) {
      this.addColumn('notes', 'created_by', 'TEXT', false, 'legacy_demo');
    }
    if (/^ALTER\s+TABLE\s+DOCUMENTS\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+CREATED_BY\b/i.test(text)) {
      this.addColumn('documents', 'created_by', 'TEXT', false, 'system');
    }

    return { rows: [] };
  }
}

describe('Migration Rehearsal Harness', () => {
  let harness;

  beforeEach(() => {
    harness = new InMemoryDatabaseHarness();
  });

  it('reports environment status & runs isolated statement-level migration rehearsal', async () => {
    console.log(
      '[MIGRATION REHEARSAL] Isolated statement-level SQL sequence test runner (live CockroachDB cluster unavailable on localhost:26257).'
    );

    const client = { query: (sql, params) => Promise.resolve(harness.query(sql, params)) };
    const { runMigrations } = await import('../migrate.mjs');

    await runMigrations({ client, embeddingDim: 1536 });

    expect(harness.hasTable('schema_migrations')).toBe(true);
    expect(harness.ledger.has('001_principal_ownership.sql')).toBe(true);
    expect(harness.hasTable('conversations')).toBe(true);
    expect(harness.hasTable('drafts')).toBe(true);
    expect(harness.hasTable('notes')).toBe(true);
    expect(harness.hasTable('documents')).toBe(true);
  });

  it('rejects a future non-index base statement before issuing any database query', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'cafe-copilot-schema-'));
    const schemaPath = path.join(tempDir, 'schema.sql');
    writeFileSync(schemaPath, `
      CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY);
      ALTER TABLE conversations ADD COLUMN future_column TEXT;
    `);

    const client = {
      query: (sql, params) => Promise.resolve(harness.query(sql, params)),
    };
    const { runMigrations } = await import('../migrate.mjs');

    try {
      await expect(runMigrations({ client, embeddingDim: 1536, schemaPath })).rejects.toThrow(
        /Unsupported non-table base schema statement/
      );
      expect(harness.queries).toEqual([]);
      expect(harness.hasTable('schema_migrations')).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rehearses legacy migration backfill and constraint evolution', async () => {
    harness.createTable('conversations', [{ name: 'id' }, { name: 'business_id' }, { name: 'title' }]);
    harness.insert('conversations', { id: 'c1', business_id: 'biz-legacy', title: 'old chat' });

    harness.createTable('drafts', [{ name: 'id' }, { name: 'business_id' }, { name: 'conversation_id' }]);
    harness.insert('drafts', { id: 'd1', business_id: 'biz-legacy', conversation_id: 'c1' });

    harness.createTable('notes', [{ name: 'id' }, { name: 'business_id' }, { name: 'content' }]);
    harness.insert('notes', { id: 'n1', business_id: 'biz-legacy', content: 'shared note' });

    harness.createTable('documents', [
      { name: 'id' },
      { name: 'business_id' },
      { name: 'doc_type' },
      { name: 'doc_date' },
    ]);
    harness.insert('documents', { id: 'doc1', business_id: 'biz-legacy', doc_type: 'daily_summary', doc_date: '2026-07-01' });

    const client = { query: (sql, params) => Promise.resolve(harness.query(sql, params)) };
    const { runMigrations } = await import('../migrate.mjs');

    await runMigrations({ client, embeddingDim: 1536 });

    const conv = harness.getTable('conversations').rows[0];
    expect(conv.actor_id).toBe('legacy_demo');
    expect(conv.access_mode).toBe('legacy_demo');

    const draft = harness.getTable('drafts').rows[0];
    expect(draft.actor_id).toBe('legacy_demo');
    expect(draft.access_mode).toBe('legacy_demo');

    const note = harness.getTable('notes').rows[0];
    expect(note.created_by).toBe('legacy_demo');

    expect(harness.ledger.has('001_principal_ownership.sql')).toBe(true);

    expect(harness.preMigrationPrincipalShape).toEqual({
      conversations: { actorId: false, accessMode: false },
      drafts: { actorId: false, accessMode: false },
      notes: { createdBy: false },
      documents: { createdBy: false },
    });

    const addActorIndex = harness.queries.findIndex((sql) =>
      /^ALTER\s+TABLE\s+CONVERSATIONS\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+ACTOR_ID\b/i.test(sql)
    );
    const principalIndex = harness.queries.findIndex((sql) =>
      /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+CONVERSATIONS_PRINCIPAL_IDX\b/i.test(sql)
    );
    expect(addActorIndex).toBeGreaterThan(-1);
    expect(principalIndex).toBeGreaterThan(addActorIndex);
  });

  it('recovers safely from a legacy catalog with an empty ledger left by the old ordering', async () => {
    harness.createTable('schema_migrations', [{ name: 'version' }, { name: 'applied_at' }]);
    harness.createTable('conversations', [{ name: 'id' }, { name: 'business_id' }, { name: 'updated_at' }]);
    harness.createTable('drafts', [{ name: 'id' }, { name: 'business_id' }, { name: 'conversation_id' }, { name: 'created_at' }]);
    harness.createTable('notes', [{ name: 'id' }, { name: 'business_id' }, { name: 'created_at' }]);
    harness.createTable('documents', [{ name: 'id' }, { name: 'business_id' }, { name: 'doc_type' }, { name: 'doc_date' }]);

    const client = { query: (sql, params) => Promise.resolve(harness.query(sql, params)) };
    const { runMigrations } = await import('../migrate.mjs');

    await runMigrations({ client, embeddingDim: 1536 });

    expect(harness.ledger.has('001_principal_ownership.sql')).toBe(true);
    expect(harness.hasColumn('conversations', 'actor_id')).toBe(true);
    expect(harness.hasColumn('conversations', 'access_mode')).toBe(true);
    expect(harness.hasColumn('drafts', 'actor_id')).toBe(true);
    expect(harness.hasColumn('drafts', 'access_mode')).toBe(true);
    expect(harness.preMigrationPrincipalShape).toEqual({
      conversations: { actorId: false, accessMode: false },
      drafts: { actorId: false, accessMode: false },
      notes: { createdBy: false },
      documents: { createdBy: false },
    });
  });

  it('accepts an already-migrated catalog without rerunning migration 001', async () => {
    harness.createTable('schema_migrations', [{ name: 'version' }, { name: 'applied_at' }]);
    harness.ledger.add('001_principal_ownership.sql');
    harness.createTable('conversations', [
      { name: 'id' }, { name: 'business_id' }, { name: 'actor_id' }, { name: 'access_mode' }, { name: 'updated_at' },
    ]);
    harness.createTable('drafts', [
      { name: 'id' }, { name: 'business_id' }, { name: 'actor_id' }, { name: 'access_mode' }, { name: 'created_at' },
    ]);
    harness.createTable('notes', [{ name: 'id' }, { name: 'business_id' }, { name: 'created_by' }, { name: 'created_at' }]);
    harness.createTable('documents', [{ name: 'id' }, { name: 'business_id' }, { name: 'created_by' }, { name: 'doc_type' }, { name: 'doc_date' }]);

    const client = { query: (sql, params) => Promise.resolve(harness.query(sql, params)) };
    const { runMigrations } = await import('../migrate.mjs');

    await runMigrations({ client, embeddingDim: 1536 });

    expect(harness.queries.some((sql) => /^ALTER\s+TABLE\s+CONVERSATIONS\s+ADD\s+COLUMN\b/i.test(sql))).toBe(false);
    expect(harness.ledger.has('001_principal_ownership.sql')).toBe(true);
  });

  it('rehearses preflight check abort on legacy database with duplicate dated documents (zero mutation)', async () => {
    harness.createTable('documents', [
      { name: 'id' },
      { name: 'business_id' },
      { name: 'doc_type' },
      { name: 'doc_date' },
    ]);
    harness.insert('documents', { id: 'doc1', business_id: 'biz-1', doc_type: 'daily_summary', doc_date: '2026-07-01' });
    harness.insert('documents', { id: 'doc2', business_id: 'biz-1', doc_type: 'daily_summary', doc_date: '2026-07-01' });

    const client = { query: (sql, params) => Promise.resolve(harness.query(sql, params)) };
    const { runMigrations } = await import('../migrate.mjs');

    await expect(runMigrations({ client, embeddingDim: 1536 })).rejects.toThrow(
      /Preflight check failed: found 0 invalid draft\(s\).*and 1 duplicate dated document group\(s\)/
    );

    expect(harness.hasTable('schema_migrations')).toBe(false);
  });

  it('rehearses resumable / idempotent execution when migration 001 is already applied', async () => {
    const client = { query: (sql, params) => Promise.resolve(harness.query(sql, params)) };
    const { runMigrations } = await import('../migrate.mjs');

    await runMigrations({ client, embeddingDim: 1536 });
    expect(harness.ledger.has('001_principal_ownership.sql')).toBe(true);

    await runMigrations({ client, embeddingDim: 1536 });
    expect(harness.ledger.has('001_principal_ownership.sql')).toBe(true);
  });
});
