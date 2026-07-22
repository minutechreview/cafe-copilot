// CockroachDB-backed memory store for Café Copilot. All functions go through a single pg
// Pool built from CRDB_CONNECTION_STRING — this module is the only place in the codebase
// that talks SQL to the memory tables (schema.sql & migrations own their shape).
import pg from 'pg';

const { Pool } = pg;

let pool;

/** Lazily creates the shared pool so importing this module never requires env vars to be set. */
function getPool() {
  if (!pool) {
    const connectionString = process.env.CRDB_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error('CRDB_CONNECTION_STRING is not configured');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
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
 * @param {Object} input - { businessId, actorId, accessMode } or object wrapping principal
 * @returns {{ businessId: string, actorId: string|null, accessMode: 'authenticated'|'demo'|'legacy_demo' }}
 */
export function normalizePrincipal(input) {
  if (!input) throw new Error('principal object is required');
  const p = input.principal || input;

  const businessId = p.businessId;
  const accessMode = p.accessMode || 'legacy_demo';
  const actorId = p.actorId || (accessMode === 'legacy_demo' ? 'legacy_demo' : null);

  if (!businessId || typeof businessId !== 'string' || !businessId.trim()) {
    throw new Error('businessId is required');
  }
  if (!['authenticated', 'demo', 'legacy_demo'].includes(accessMode)) {
    throw new Error("accessMode must be 'authenticated', 'demo', or 'legacy_demo'");
  }
  if (accessMode !== 'legacy_demo') {
    if (!actorId || typeof actorId !== 'string' || !actorId.trim()) {
      throw new Error('actorId is required for authenticated or demo accessMode');
    }
  }

  return {
    businessId: businessId.trim(),
    actorId: actorId ? actorId.trim() : null,
    accessMode,
  };
}

/**
 * Resolves (principal, payload) from flexible function argument styles.
 * Supports:
 * - store.fn(principal, payload)
 * - store.fn({ principal, ...payload })
 * - store.fn({ businessId, actorId, accessMode, ...payload })
 */
function resolveCallArgs(arg1, arg2) {
  if (arg1 && arg1.principal) {
    return { principal: arg1.principal, input: arg2 && Object.keys(arg2).length > 0 ? arg2 : arg1 };
  }
  if (arg2 && typeof arg2 === 'object' && Object.keys(arg2).length > 0) {
    return { principal: arg1, input: arg2 };
  }
  return { principal: arg1, input: arg1 || {} };
}

/**
 * Creates a new conversation for a principal and returns its id.
 * @param {Object} arg1
 * @param {Object} [arg2]
 * @returns {Promise<string>} conversation id
 */
export async function createConversation(arg1, arg2) {
  const { principal, input } = resolveCallArgs(arg1, arg2);
  const p = normalizePrincipal(principal);
  const title = input.title || null;

  const { rows } = await getPool().query(
    `INSERT INTO conversations (business_id, actor_id, access_mode, title)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [p.businessId, p.actorId, p.accessMode, title]
  );
  return rows[0].id;
}

/**
 * Appends a message to a conversation owned by the requesting principal and bumps updated_at.
 * Uses atomic INSERT ... SELECT predicate to prevent TOCTOU race conditions and cross-principal access.
 * @param {Object} arg1
 * @param {Object} [arg2]
 * @returns {Promise<string>} message id
 */
export async function appendMessage(arg1, arg2) {
  const { principal, input } = resolveCallArgs(arg1, arg2);
  const p = normalizePrincipal(principal);

  const conversationId = input.conversationId;
  const role = input.role;
  const content = input.content;

  if (!conversationId) throw new Error('conversationId is required');
  if (role !== 'user' && role !== 'assistant') {
    throw new Error("role must be 'user' or 'assistant'");
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO messages (conversation_id, role, content)
       SELECT c.id, $2, $3
         FROM conversations c
        WHERE c.id = $1
          AND c.business_id = $4
          AND (c.actor_id = $5 OR (c.actor_id IS NULL AND $5 IS NULL))
          AND c.access_mode = $6
       RETURNING id`,
      [conversationId, role, content, p.businessId, p.actorId, p.accessMode]
    );

    if (!rows || rows.length === 0) {
      throw new Error('Access denied or conversation not found');
    }

    const messageId = rows[0].id;

    await client.query(
      `UPDATE conversations
          SET updated_at = now()
        WHERE id = $1
          AND business_id = $2
          AND (actor_id = $3 OR (actor_id IS NULL AND $3 IS NULL))
          AND access_mode = $4`,
      [conversationId, p.businessId, p.actorId, p.accessMode]
    );

    await client.query('COMMIT');
    return messageId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Returns the most recent messages in a conversation owned by the requesting principal.
 * @param {Object} arg1
 * @param {string|number} [arg2]
 * @param {number} [arg3=12]
 * @returns {Promise<{role: string, content: string, createdAt: Date}[]>}
 */
export async function getRecentMessages(arg1, arg2, arg3 = 12) {
  if (typeof arg1 === 'string' && !arg2) {
    throw new Error('principal is required');
  }

  let principal, conversationId, limit;
  if (arg1 && arg1.principal) {
    principal = arg1.principal;
    conversationId = arg1.conversationId || arg2;
    limit = arg1.limit || arg3 || 12;
  } else if (typeof arg2 === 'string') {
    principal = arg1;
    conversationId = arg2;
    limit = arg3 || 12;
  } else if (arg1 && arg1.conversationId) {
    principal = arg1;
    conversationId = arg1.conversationId;
    limit = arg1.limit || arg2 || 12;
  } else {
    principal = arg1;
    conversationId = arg2;
    limit = arg3 || 12;
  }

  const p = normalizePrincipal(principal);
  if (!conversationId) throw new Error('conversationId is required');

  const { rows } = await getPool().query(
    `SELECT m.role, m.content, m.created_at
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
      WHERE c.id = $1
        AND c.business_id = $2
        AND (c.actor_id = $3 OR (c.actor_id IS NULL AND $3 IS NULL))
        AND c.access_mode = $4
      ORDER BY m.created_at DESC
      LIMIT $5`,
    [conversationId, p.businessId, p.actorId, p.accessMode, limit]
  );

  return rows
    .map((row) => ({ role: row.role, content: row.content, createdAt: row.created_at }))
    .reverse();
}

/**
 * Saves a durable business-context note carrying created_by.
 * @param {Object} arg1
 * @param {Object} [arg2]
 */
export async function saveNote(arg1, arg2) {
  const { principal, input } = resolveCallArgs(arg1, arg2);
  const p = normalizePrincipal(principal);

  const content = input.content;
  const source = input.source || null;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }

  const createdBy = p.actorId || p.accessMode;

  const { rows } = await getPool().query(
    `INSERT INTO notes (business_id, actor_id, access_mode, created_by, content, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [p.businessId, p.actorId, p.accessMode, createdBy, content, source]
  );
  return rows[0].id;
}

/**
 * Lists business-context notes for a business.
 * @param {Object} arg1
 */
export async function listNotes(arg1) {
  const principalObj = arg1?.principal || arg1;
  const p = normalizePrincipal(principalObj);

  const { rows } = await getPool().query(
    `SELECT id, content, source, created_by, created_at
       FROM notes
      WHERE business_id = $1
      ORDER BY created_at DESC`,
    [p.businessId]
  );
  return rows;
}

/**
 * Saves a draft artifact for a principal.
 * If conversationId is supplied, verifies it belongs to the exact same principal.
 * @param {Object} arg1
 * @param {Object} [arg2]
 */
export async function saveDraft(arg1, arg2) {
  const { principal, input } = resolveCallArgs(arg1, arg2);
  const p = normalizePrincipal(principal);

  const conversationId = input.conversationId || null;
  const kind = input.kind;
  const payload = input.payload;

  if (!kind) throw new Error('kind is required');
  if (!payload || typeof payload !== 'object') throw new Error('payload must be an object');

  if (conversationId) {
    const { rows } = await getPool().query(
      `INSERT INTO drafts (business_id, actor_id, access_mode, conversation_id, kind, payload)
       SELECT $1, $2, $3, c.id, $4, $5
         FROM conversations c
        WHERE c.id = $6
          AND c.business_id = $1
          AND (c.actor_id = $2 OR (c.actor_id IS NULL AND $2 IS NULL))
          AND c.access_mode = $3
       RETURNING id`,
      [p.businessId, p.actorId, p.accessMode, kind, JSON.stringify(payload), conversationId]
    );

    if (!rows || rows.length === 0) {
      throw new Error('Access denied or invalid conversationId for draft');
    }
    return rows[0].id;
  }

  const { rows } = await getPool().query(
    `INSERT INTO drafts (business_id, actor_id, access_mode, conversation_id, kind, payload)
     VALUES ($1, $2, $3, NULL, $4, $5)
     RETURNING id`,
    [p.businessId, p.actorId, p.accessMode, kind, JSON.stringify(payload)]
  );
  return rows[0].id;
}

/**
 * Inserts or replaces an embedded document.
 * @param {Object} arg1
 * @param {Object} [arg2]
 */
export async function upsertDocument(arg1, arg2) {
  const { principal, input } = resolveCallArgs(arg1, arg2);
  const p = normalizePrincipal(principal);

  const id = input.id || null;
  const docType = input.docType;
  const docDate = input.docDate || null;
  const content = input.content;
  const metadata = input.metadata || {};
  const embedding = input.embedding;

  if (!docType) throw new Error('docType is required');
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }
  const vectorLiteral = toVectorLiteral(embedding);
  const createdBy = p.actorId || p.accessMode;

  let targetId = id;
  if (!targetId && docDate) {
    const { rows: existing } = await getPool().query(
      'SELECT id FROM documents WHERE business_id = $1 AND doc_type = $2 AND doc_date = $3',
      [p.businessId, docType, docDate]
    );
    targetId = existing[0]?.id ?? null;
  }

  if (targetId) {
    const { rows } = await getPool().query(
      `UPSERT INTO documents (id, business_id, created_by, doc_type, doc_date, content, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [targetId, p.businessId, createdBy, docType, docDate, content, JSON.stringify(metadata), vectorLiteral]
    );
    return rows[0].id;
  }

  const { rows } = await getPool().query(
    `INSERT INTO documents (business_id, created_by, doc_type, doc_date, content, metadata, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [p.businessId, createdBy, docType, docDate, content, JSON.stringify(metadata), vectorLiteral]
  );
  return rows[0].id;
}

/**
 * Vector-searches documents for a business.
 * @param {Object} arg1
 * @param {number[]} arg2
 * @param {number} [arg3=5]
 */
export async function searchDocuments(arg1, arg2, arg3 = 5) {
  let principalObj, queryEmbedding, k;
  if (Array.isArray(arg2)) {
    principalObj = typeof arg1 === 'string' ? { businessId: arg1 } : arg1;
    queryEmbedding = arg2;
    k = arg3;
  } else {
    const { principal, input } = resolveCallArgs(arg1, arg2);
    principalObj = principal;
    queryEmbedding = input.queryEmbedding || arg2;
    k = input.k || arg3 || 5;
  }

  const p = normalizePrincipal(principalObj);
  const vectorLiteral = toVectorLiteral(queryEmbedding);
  const { rows } = await getPool().query(
    `SELECT id, doc_type, doc_date, content, metadata, embedding <=> $2 AS distance
       FROM documents
      WHERE business_id = $1
      ORDER BY embedding <=> $2
      LIMIT $3`,
    [p.businessId, vectorLiteral, k]
  );
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
