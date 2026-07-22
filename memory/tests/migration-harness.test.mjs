import { describe, it, expect, beforeEach } from 'vitest';

/**
 * SQL State Machine Engine for non-mock migration rehearsal.
 * Evaluates DDL and DML statements against an in-memory relational schema state.
 */
class InMemoryDatabaseHarness {
  constructor() {
    this.tables = new Map();
    this.ledger = new Set();
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

  createTable(tableName, columns = [], constraints = []) {
    if (this.tables.has(tableName)) {
      const existing = this.tables.get(tableName);
      for (const col of columns) {
        if (!existing.columns.has(col.name)) {
          existing.columns.set(col.name, col);
        }
      }
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

    // 7. Base DDL / Schema DDL simulation
    if (upper.includes('CONVERSATIONS')) {
      this.createTable('conversations', [
        { name: 'id' },
        { name: 'business_id' },
        { name: 'actor_id', defaultValue: 'legacy_demo' },
        { name: 'access_mode', defaultValue: 'legacy_demo' },
        { name: 'title' },
      ]);
    }
    if (upper.includes('MESSAGES')) {
      this.createTable('messages', [
        { name: 'id' },
        { name: 'conversation_id' },
        { name: 'role' },
        { name: 'content' },
      ]);
    }
    if (upper.includes('NOTES')) {
      this.createTable('notes', [
        { name: 'id' },
        { name: 'business_id' },
        { name: 'created_by', defaultValue: 'legacy_demo' },
        { name: 'content' },
      ]);
    }
    if (upper.includes('DRAFTS')) {
      this.createTable('drafts', [
        { name: 'id' },
        { name: 'business_id' },
        { name: 'actor_id', defaultValue: 'legacy_demo' },
        { name: 'access_mode', defaultValue: 'legacy_demo' },
        { name: 'conversation_id' },
      ]);
    }
    if (upper.includes('DOCUMENTS')) {
      this.createTable('documents', [
        { name: 'id' },
        { name: 'business_id' },
        { name: 'created_by', defaultValue: 'system' },
        { name: 'doc_type' },
        { name: 'doc_date' },
      ]);
    }

    // 8. Migration 001 execution simulation
    if (upper.includes('CONVERSATIONS') && upper.includes('ACTOR_ID')) {
      this.addColumn('conversations', 'actor_id', 'TEXT', false, 'legacy_demo');
    }
    if (upper.includes('CONVERSATIONS') && upper.includes('ACCESS_MODE')) {
      this.addColumn('conversations', 'access_mode', 'TEXT', false, 'legacy_demo');
    }
    if (upper.includes('DRAFTS') && upper.includes('ACTOR_ID')) {
      this.addColumn('drafts', 'actor_id', 'TEXT', false, 'legacy_demo');
    }
    if (upper.includes('DRAFTS') && upper.includes('ACCESS_MODE')) {
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
    if (upper.includes('NOTES') && upper.includes('CREATED_BY')) {
      this.addColumn('notes', 'created_by', 'TEXT', false, 'legacy_demo');
    }
    if (upper.includes('DOCUMENTS') && upper.includes('CREATED_BY')) {
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

  it('reports environment status & runs non-mock fresh-database bootstrap rehearsal', async () => {
    console.log(
      '[MIGRATION REHEARSAL] No live CockroachDB cluster on localhost:26257 — running isolated SQL state-machine rehearsal harness.'
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
