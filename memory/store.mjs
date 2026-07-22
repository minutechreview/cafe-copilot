// CockroachDB-backed memory store for Café Copilot. All functions go through a single pg
// Pool built from CRDB_CONNECTION_STRING — this module is the only place in the codebase
// that talks SQL to the memory tables (schema.sql & migrations own their shape).
//
// Note on application compatibility:
// Full application transport integration of authenticated/demo principals is completed in Step 4.
// Until Step 4, this branch remains unmerged on feat/memory-principal-ownership.
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
 * Requires explicit non-blank businessId, actorId, and accessMode.
 * @param {Object} input - { businessId, actorId, accessMode } or object wrapping principal
 * @returns {{ businessId: string, actorId: string, accessMode: 'authenticated'|'demo'|'legacy_demo' }}
 */
export function normalizePrincipal(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('principal object is required');
  }
  const p = input.principal || input;

  const businessId = p.businessId;
  const actorId = p.actorId;
  const accessMode = p.accessMode;

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
 * @param {Object} principal
 * @param {{ title?: string }} [input]
 * @returns {Promise<string>} conversation id
 */
export async function createConversation(principal, input = {}) {
  const p = normalizePrincipal(principal);
  const title = typeof input?.title === 'string' && input.title.trim() ? input.title.trim() : null;

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
 * @param {Object} principal
 * @param {{ conversationId: string, role: 'user'|'assistant', content: string }} input
 * @returns {Promise<string>} message id
 */
export async function appendMessage(principal, input = {}) {
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

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

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

    await client.query(
      `UPDATE conversations
          SET updated_at = now()
        WHERE id = $1
          AND business_id = $2
          AND actor_id = $3
          AND access_mode = $4`,
      [conversationId.trim(), p.businessId, p.actorId, p.accessMode]
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
 * @param {Object} principal
 * @param {string} conversationId
 * @param {number} [limit=12]
 * @returns {Promise<{role: string, content: string, createdAt: Date}[]>}
 */
export async function getRecentMessages(principal, conversationId, limit = 12) {
  const p = normalizePrincipal(principal);
  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('conversationId is required');
  }

  const numericLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;

  const { rows } = await getPool().query(
    `SELECT m.role, m.content, m.created_at
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
      WHERE c.id = $1
        AND c.business_id = $2
        AND c.actor_id = $3
        AND c.access_mode = $4
      ORDER BY m.created_at DESC
      LIMIT $5`,
    [conversationId.trim(), p.businessId, p.actorId, p.accessMode, numericLimit]
  );

  return rows
    .map((row) => ({ role: row.role, content: row.content, createdAt: row.created_at }))
    .reverse();
}

/**
 * Saves a durable business-context note carrying created_by.
 * @param {Object} principal
 * @param {{ content: string, source?: string }} input
 */
export async function saveNote(principal, input = {}) {
  const p = normalizePrincipal(principal);
  const content = input?.content;
  const source = typeof input?.source === 'string' && input.source.trim() ? input.source.trim() : null;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }

  const { rows } = await getPool().query(
    `INSERT INTO notes (business_id, created_by, actor_id, access_mode, content, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [p.businessId, p.actorId, p.actorId, p.accessMode, content, source]
  );
  return rows[0].id;
}

/**
 * Lists business-context notes for a business.
 * @param {Object} principal
 */
export async function listNotes(principal) {
  const p = normalizePrincipal(principal);

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
 * If conversationId is supplied, verifies it belongs to the exact same principal via atomic composite predicate.
 * @param {Object} principal
 * @param {{ conversationId?: string, kind: string, payload: object }} input
 */
export async function saveDraft(principal, input = {}) {
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
    const { rows } = await getPool().query(
      `INSERT INTO drafts (business_id, actor_id, access_mode, conversation_id, kind, payload)
       SELECT $1, $2, $3, c.id, $4, $5
         FROM conversations c
        WHERE c.id = $6
          AND c.business_id = $1
          AND c.actor_id = $2
          AND c.access_mode = $3
       RETURNING id`,
      [p.businessId, p.actorId, p.accessMode, kind.trim(), JSON.stringify(payload), conversationId]
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
    [p.businessId, p.actorId, p.accessMode, kind.trim(), JSON.stringify(payload)]
  );
  return rows[0].id;
}

/**
 * Inserts or updates an embedded document.
 * Explicit ID updates are restricted to the matching business_id and preserve immutable created_by.
 * Dated documents use an atomic ON CONFLICT strategy without SELECT-then-UPSERT races.
 * @param {Object} principal
 * @param {{ id?: string, docType: string, docDate?: string|null, content: string, metadata?: object, embedding: number[] }} input
 */
export async function upsertDocument(principal, input = {}) {
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
    const { rows } = await getPool().query(
      `UPDATE documents
          SET doc_type = $3,
              doc_date = $4,
              content = $5,
              metadata = $6,
              embedding = $7
        WHERE id = $1
          AND business_id = $2
        RETURNING id`,
      [explicitId, p.businessId, docType.trim(), docDate, content, JSON.stringify(metadata), vectorLiteral]
    );

    if (!rows || rows.length === 0) {
      throw new Error('Access denied or document not found');
    }
    return rows[0].id;
  }

  if (docDate) {
    const { rows } = await getPool().query(
      `INSERT INTO documents (business_id, created_by, doc_type, doc_date, content, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, doc_type, doc_date) WHERE doc_date IS NOT NULL
       DO UPDATE SET content = EXCLUDED.content,
                     metadata = EXCLUDED.metadata,
                     embedding = EXCLUDED.embedding
       RETURNING id`,
      [p.businessId, p.actorId, docType.trim(), docDate, content, JSON.stringify(metadata), vectorLiteral]
    );
    return rows[0].id;
  }

  const { rows } = await getPool().query(
    `INSERT INTO documents (business_id, created_by, doc_type, doc_date, content, metadata, embedding)
     VALUES ($1, $2, $3, NULL, $4, $5, $6)
     RETURNING id`,
    [p.businessId, p.actorId, docType.trim(), content, JSON.stringify(metadata), vectorLiteral]
  );
  return rows[0].id;
}

/**
 * Vector-searches documents for a business.
 * @param {Object} principal
 * @param {number[]} queryEmbedding
 * @param {number} [k=5]
 */
export async function searchDocuments(principal, queryEmbedding, k = 5) {
  const p = normalizePrincipal(principal);
  const vectorLiteral = toVectorLiteral(queryEmbedding);
  const numericK = Number.isFinite(k) && k > 0 ? Math.floor(k) : 5;

  const { rows } = await getPool().query(
    `SELECT id, doc_type, doc_date, content, metadata, embedding <=> $2 AS distance
       FROM documents
      WHERE business_id = $1
      ORDER BY embedding <=> $2
      LIMIT $3`,
    [p.businessId, vectorLiteral, numericK]
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
