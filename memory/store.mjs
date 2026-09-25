// CockroachDB-backed memory store for Café Copilot. All functions go through a single pg
// Pool built from CRDB_CONNECTION_STRING — this module is the only place in the codebase
// that talks SQL to the memory tables (schema.sql & migrations own their shape).
import pg from 'pg';

const { Pool } = pg;

let pool;

const DEFAULT_POOL_MAX = 4;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const MAX_MEMORY_SEARCH_RESULTS = 20;
const MAX_LIST_NOTES_RESULTS = 50;

function configuredPositiveInteger(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

/** Bounded, Lambda-safe pool configuration. Values are server-only environment settings. */
export function getPoolOptions(connectionString = process.env.CRDB_CONNECTION_STRING) {
  if (!connectionString || typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new Error('CRDB_CONNECTION_STRING is not configured');
  }
  return {
    connectionString,
    max: configuredPositiveInteger('CRDB_POOL_MAX', DEFAULT_POOL_MAX, 10),
    connectionTimeoutMillis: configuredPositiveInteger('CRDB_CONNECTION_TIMEOUT_MS', DEFAULT_CONNECTION_TIMEOUT_MS, 10_000),
    idleTimeoutMillis: configuredPositiveInteger('CRDB_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS, 60_000),
    query_timeout: configuredPositiveInteger('CRDB_QUERY_TIMEOUT_MS', DEFAULT_QUERY_TIMEOUT_MS, 30_000),
    statement_timeout: configuredPositiveInteger('CRDB_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS, 30_000),
  };
}

/** Lazily creates the shared pool so importing this module never requires env vars to be set. */
function getPool() {
  if (!pool) {
    pool = new Pool(getPoolOptions());
  }
  return pool;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Request deadline exceeded');
    error.name = 'AbortError';
    throw error;
  }
}

function bindAbort(client, signal) {
  let destroyed = false;
  const onAbort = () => {
    destroyed = true;
    client.release(true);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    cleanup: () => signal?.removeEventListener('abort', onAbort),
    destroyed: () => destroyed,
  };
}

async function runQuery(text, values, signal) {
  throwIfAborted(signal);
  if (!signal) {
    return values === undefined ? getPool().query(text) : getPool().query(text, values);
  }
  const client = await getPool().connect();
  const abort = bindAbort(client, signal);
  try {
    throwIfAborted(signal);
    const result = values === undefined ? await client.query(text) : await client.query(text, values);
    throwIfAborted(signal);
    return result;
  } finally {
    abort.cleanup();
    if (!abort.destroyed()) client.release();
  }
}

/** Formats a JS number array as the literal CockroachDB VECTOR syntax expects, e.g. '[0.1,0.2]'. */
function toVectorLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('embedding must be a non-empty number array');
  }
  return `[${embedding.join(',')}]`;
}

/**
 * Validates and normalizes a principal context object.
 * Accepts ONLY the direct explicit principal shape { businessId, actorId, accessMode }.
 * @param {{ businessId: string, actorId: string, accessMode: 'authenticated'|'demo'|'legacy_demo' }} principal
 * @returns {{ businessId: string, actorId: string, accessMode: 'authenticated'|'demo'|'legacy_demo' }}
 */
export function normalizePrincipal(principal) {
  if (!principal || typeof principal !== 'object') {
    throw new Error('principal object is required');
  }

  const { businessId, actorId, accessMode } = principal;

  if (!businessId || typeof businessId !== 'string' || !businessId.trim()) {
    throw new Error('principal.businessId is required');
  }

  if (!accessMode || typeof accessMode !== 'string' || !['authenticated', 'demo', 'legacy_demo'].includes(accessMode.trim())) {
    throw new Error("principal.accessMode must be 'authenticated', 'demo', or 'legacy_demo'");
  }

  if (!actorId || typeof actorId !== 'string' || !actorId.trim()) {
    throw new Error('principal.actorId is required');
  }

  return {
    businessId: businessId.trim(),
    actorId: actorId.trim(),
    accessMode: accessMode.trim(),
  };
}

/**
 * Creates a new conversation for a principal and returns its id.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {{ title?: string }} [input]
 * @returns {Promise<string>} conversation id
 */
export async function createConversation(principal, input = {}, { signal } = {}) {
  const p = normalizePrincipal(principal);
  const title = typeof input?.title === 'string' && input.title.trim() ? input.title.trim() : null;

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `INSERT INTO conversations (business_id, actor_id, access_mode, title)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [p.businessId, p.actorId, p.accessMode, title], signal
  );
  return rows[0].id;
}

/** Returns whether a conversation belongs to the exact business, actor, and access mode. */
export async function conversationExists(principal, conversationId, { signal } = {}) {
  const p = normalizePrincipal(principal);
  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) return false;
  throwIfAborted(signal);
  const { rows } = await runQuery(
    `SELECT EXISTS (
       SELECT 1 FROM conversations
        WHERE id = $1
          AND business_id = $2
          AND actor_id = $3
          AND access_mode = $4
     ) AS owned`,
    [conversationId.trim(), p.businessId, p.actorId, p.accessMode], signal
  );
  throwIfAborted(signal);
  return rows[0]?.owned === true;
}

/**
 * Appends a message to a conversation owned by the requesting principal and bumps updated_at.
 * Uses atomic INSERT ... SELECT predicate to prevent TOCTOU race conditions and cross-principal access.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {{ conversationId: string, role: 'user'|'assistant', content: string }} input
 * @returns {Promise<string>} message id
 */
export async function appendMessage(principal, input = {}, { signal } = {}) {
  const p = normalizePrincipal(principal);
  const conversationId = input?.conversationId;
  const role = input?.role;
  const content = input?.content;

  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('conversationId is required');
  }
  if (role !== 'user' && role !== 'assistant') {
    throw new Error("role must be 'user' or 'assistant'");
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }

  throwIfAborted(signal);
  const client = await getPool().connect();
  const abort = bindAbort(client, signal);
  try {
    throwIfAborted(signal);
    await client.query('BEGIN');

    throwIfAborted(signal);
    const { rows } = await client.query(
      `INSERT INTO messages (conversation_id, role, content)
       SELECT c.id, $2, $3
         FROM conversations c
        WHERE c.id = $1
          AND c.business_id = $4
          AND c.actor_id = $5
          AND c.access_mode = $6
       RETURNING id`,
      [conversationId.trim(), role, content, p.businessId, p.actorId, p.accessMode]
    );

    if (!rows || rows.length === 0) {
      throw new Error('Access denied or conversation not found');
    }

    const messageId = rows[0].id;

    throwIfAborted(signal);
    await client.query(
      `UPDATE conversations
          SET updated_at = now()
        WHERE id = $1
          AND business_id = $2
          AND actor_id = $3
          AND access_mode = $4`,
      [conversationId.trim(), p.businessId, p.actorId, p.accessMode]
    );

    throwIfAborted(signal);
    await client.query('COMMIT');
    throwIfAborted(signal);
    return messageId;
  } catch (err) {
    if (!abort.destroyed()) await client.query('ROLLBACK');
    throw err;
  } finally {
    abort.cleanup();
    if (!abort.destroyed()) client.release();
  }
}

/**
 * Returns the most recent messages in a conversation owned by the requesting principal.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {string} conversationId
 * @param {number} [limit=12]
 * @returns {Promise<{role: string, content: string, createdAt: Date}[]>}
 */
export async function getRecentMessages(principal, conversationId, limit = 12, { signal } = {}) {
  const p = normalizePrincipal(principal);
  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('conversationId is required');
  }

  const numericLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `SELECT m.role, m.content, m.created_at
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
      WHERE c.id = $1
        AND c.business_id = $2
        AND c.actor_id = $3
        AND c.access_mode = $4
      ORDER BY m.created_at DESC
      LIMIT $5`,
    [conversationId.trim(), p.businessId, p.actorId, p.accessMode, numericLimit], signal
  );
  throwIfAborted(signal);

  return rows
    .map((row) => ({ role: row.role, content: row.content, createdAt: row.created_at }))
    .reverse();
}

/**
 * Lists a principal's conversations, most-recently-updated first.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @returns {Promise<{id: string, title: string|null, updatedAt: Date}[]>}
 */
export async function listConversations(principal, { signal } = {}) {
  const p = normalizePrincipal(principal);

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `SELECT id, title, updated_at
       FROM conversations
      WHERE business_id = $1
        AND actor_id = $2
        AND access_mode = $3
      ORDER BY updated_at DESC`,
    [p.businessId, p.actorId, p.accessMode], signal
  );
  throwIfAborted(signal);

  return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
}

/**
 * Returns the full message history of a conversation owned by the requesting principal,
 * oldest first, with no limit. Caller must check `conversationExists` first to distinguish
 * "not owned" from "owned but empty" — this returns [] for both.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {string} conversationId
 * @returns {Promise<{role: string, content: string}[]>}
 */
export async function getConversationMessages(principal, conversationId, { signal } = {}) {
  const p = normalizePrincipal(principal);
  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('conversationId is required');
  }

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `SELECT m.role, m.content
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
      WHERE c.id = $1
        AND c.business_id = $2
        AND c.actor_id = $3
        AND c.access_mode = $4
      ORDER BY m.created_at ASC`,
    [conversationId.trim(), p.businessId, p.actorId, p.accessMode], signal
  );
  throwIfAborted(signal);

  return rows.map((row) => ({ role: row.role, content: row.content }));
}

/**
 * Renames a conversation owned by the requesting principal.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {string} conversationId
 * @param {string} title
 * @returns {Promise<boolean>} whether a conversation was actually renamed
 */
export async function renameConversation(principal, conversationId, title, { signal } = {}) {
  const p = normalizePrincipal(principal);
  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('conversationId is required');
  }
  const trimmedTitle = typeof title === 'string' ? title.trim() : '';
  if (!trimmedTitle) {
    throw new Error('title is required');
  }

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `UPDATE conversations
        SET title = $1,
            updated_at = now()
      WHERE id = $2
        AND business_id = $3
        AND actor_id = $4
        AND access_mode = $5
      RETURNING id`,
    [trimmedTitle, conversationId.trim(), p.businessId, p.actorId, p.accessMode], signal
  );
  throwIfAborted(signal);

  return rows.length > 0;
}

/**
 * Deletes a conversation owned by the requesting principal. Its messages cascade via the
 * existing messages_conversation_id_fkey ON DELETE CASCADE.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {string} conversationId
 * @returns {Promise<boolean>} whether a conversation was actually deleted
 */
export async function deleteConversation(principal, conversationId, { signal } = {}) {
  const p = normalizePrincipal(principal);
  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('conversationId is required');
  }

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `DELETE FROM conversations
      WHERE id = $1
        AND business_id = $2
        AND actor_id = $3
        AND access_mode = $4
      RETURNING id`,
    [conversationId.trim(), p.businessId, p.actorId, p.accessMode], signal
  );
  throwIfAborted(signal);

  return rows.length > 0;
}

/**
 * Saves a durable business-context note carrying created_by.
 * Notes remain business-shared.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {{ content: string, source?: string }} input
 */
export async function saveNote(principal, input = {}, { signal } = {}) {
  const p = normalizePrincipal(principal);
  const content = input?.content;
  const source = typeof input?.source === 'string' && input.source.trim() ? input.source.trim() : null;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `INSERT INTO notes (business_id, created_by, content, source)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [p.businessId, p.actorId, content, source], signal
  );
  return rows[0].id;
}

/**
 * Lists business-context notes for a business.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 */
export async function listNotes(principal, { signal } = {}) {
  const p = normalizePrincipal(principal);

  let sql;
  let values;
  if (p.accessMode === 'authenticated') {
    sql = `SELECT id, content, source, created_by, created_at
             FROM notes
            WHERE business_id = $1
              AND created_by NOT LIKE 'demo-session-%'
              AND created_by <> 'legacy_demo'
            ORDER BY created_at DESC
            LIMIT $2`;
    values = [p.businessId, MAX_LIST_NOTES_RESULTS];
  } else {
    sql = `SELECT id, content, source, created_by, created_at
             FROM notes
            WHERE business_id = $1
              AND created_by = $2
            ORDER BY created_at DESC
            LIMIT $3`;
    values = [p.businessId, p.actorId, MAX_LIST_NOTES_RESULTS];
  }
  throwIfAborted(signal);
  const { rows } = await runQuery(sql, values, signal);
  throwIfAborted(signal);
  return rows;
}

/**
 * Saves a draft artifact for a principal.
 * If conversationId is supplied, verifies it belongs to the exact same principal via atomic composite predicate.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {{ conversationId?: string, kind: string, payload: object }} input
 */
export async function saveDraft(principal, input = {}, { signal } = {}) {
  const p = normalizePrincipal(principal);
  const conversationId = typeof input?.conversationId === 'string' && input.conversationId.trim() ? input.conversationId.trim() : null;
  const kind = input?.kind;
  const payload = input?.payload;

  if (!kind || typeof kind !== 'string' || !kind.trim()) {
    throw new Error('kind is required');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload must be an object');
  }

  if (conversationId) {
    throwIfAborted(signal);
    const { rows } = await runQuery(
      `INSERT INTO drafts (business_id, actor_id, access_mode, conversation_id, kind, payload)
       SELECT $1, $2, $3, c.id, $4, $5
         FROM conversations c
        WHERE c.id = $6
          AND c.business_id = $1
          AND c.actor_id = $2
          AND c.access_mode = $3
       RETURNING id`,
      [p.businessId, p.actorId, p.accessMode, kind.trim(), JSON.stringify(payload), conversationId], signal
    );

    if (!rows || rows.length === 0) {
      throw new Error('Access denied or invalid conversationId for draft');
    }
    return rows[0].id;
  }

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `INSERT INTO drafts (business_id, actor_id, access_mode, conversation_id, kind, payload)
     VALUES ($1, $2, $3, NULL, $4, $5)
     RETURNING id`,
    [p.businessId, p.actorId, p.accessMode, kind.trim(), JSON.stringify(payload)], signal
  );
  return rows[0].id;
}

/**
 * Inserts or updates an embedded document.
 * Explicit ID updates are restricted to the matching business_id and preserve immutable created_by.
 * Dated documents use an atomic ON CONFLICT strategy without SELECT-then-UPSERT races.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {{ id?: string, docType: string, docDate?: string|null, content: string, metadata?: object, embedding: number[] }} input
 */
export async function upsertDocument(principal, input = {}, { signal } = {}) {
  const p = normalizePrincipal(principal);

  const explicitId = typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : null;
  const docType = input?.docType;
  const docDate = typeof input?.docDate === 'string' && input.docDate.trim() ? input.docDate.trim() : null;
  const content = input?.content;
  const metadata = input?.metadata || {};
  const embedding = input?.embedding;

  if (!docType || typeof docType !== 'string' || !docType.trim()) {
    throw new Error('docType is required');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }
  const vectorLiteral = toVectorLiteral(embedding);

  if (explicitId) {
    throwIfAborted(signal);
    const { rows } = await runQuery(
      `UPDATE documents
          SET doc_type = $3,
              doc_date = $4,
              content = $5,
              metadata = $6,
              embedding = $7
        WHERE id = $1
          AND business_id = $2
        RETURNING id`,
      [explicitId, p.businessId, docType.trim(), docDate, content, JSON.stringify(metadata), vectorLiteral], signal
    );

    if (!rows || rows.length === 0) {
      throw new Error('Access denied or document not found');
    }
    return rows[0].id;
  }

  if (docDate) {
    throwIfAborted(signal);
    const { rows } = await runQuery(
      `INSERT INTO documents (business_id, created_by, doc_type, doc_date, content, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, doc_type, doc_date) WHERE doc_date IS NOT NULL
       DO UPDATE SET content = EXCLUDED.content,
                     metadata = EXCLUDED.metadata,
                     embedding = EXCLUDED.embedding
       RETURNING id`,
      [p.businessId, p.actorId, docType.trim(), docDate, content, JSON.stringify(metadata), vectorLiteral], signal
    );
    return rows[0].id;
  }

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `INSERT INTO documents (business_id, created_by, doc_type, doc_date, content, metadata, embedding)
     VALUES ($1, $2, $3, NULL, $4, $5, $6)
     RETURNING id`,
    [p.businessId, p.actorId, docType.trim(), content, JSON.stringify(metadata), vectorLiteral], signal
  );
  return rows[0].id;
}

/**
 * Vector-searches documents for a business.
 * @param {{ businessId: string, actorId: string, accessMode: string }} principal
 * @param {number[]} queryEmbedding
 * @param {number} [k=5]
 */
export async function searchDocuments(principal, queryEmbedding, k = 5, { signal } = {}) {
  const p = normalizePrincipal(principal);
  const vectorLiteral = toVectorLiteral(queryEmbedding);
  const requestedK = Number.isFinite(k) && k > 0 ? Math.floor(k) : 5;
  const numericK = Math.min(requestedK, MAX_MEMORY_SEARCH_RESULTS);

  throwIfAborted(signal);
  const { rows } = await runQuery(
    `SELECT id, doc_type, doc_date, content, metadata, embedding <=> $2 AS distance
       FROM documents
      WHERE business_id = $1
      ORDER BY embedding <=> $2
      LIMIT $3`,
    [p.businessId, vectorLiteral, numericK], signal
  );
  throwIfAborted(signal);

  return rows.map((row) => ({
    id: row.id,
    docType: row.doc_type,
    docDate: row.doc_date,
    content: row.content,
    metadata: row.metadata,
    distance: row.distance,
  }));
}

/** Closes the shared pool. */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
