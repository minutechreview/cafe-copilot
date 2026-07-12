// CockroachDB-backed memory store for Café Copilot. All functions go through a single pg
// Pool built from CRDB_CONNECTION_STRING — this module is the only place in the codebase
// that talks SQL to the memory tables (schema.sql owns their shape).
//
// Vector search uses the cosine distance operator `<=>` — see the comment at the top of
// schema.sql for why (CockroachDB confirmed to support <->, <=>, and <#> live; Titan Text
// Embeddings v2 is called with normalize:true, making cosine the natural fit).
import pg from 'pg';

const { Pool } = pg;

let pool;

/** Lazily creates the shared pool so importing this module never requires env vars to be set (tests mock pg entirely). */
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
 * Creates a new conversation for a business and returns its id.
 * @param {{ businessId: string, title?: string }} input
 * @returns {Promise<string>} conversation id
 */
export async function createConversation({ businessId, title = null }) {
  if (!businessId) throw new Error('businessId is required');
  const { rows } = await getPool().query(
    'INSERT INTO conversations (business_id, title) VALUES ($1, $2) RETURNING id',
    [businessId, title]
  );
  return rows[0].id;
}

/**
 * Appends a message to a conversation and bumps the conversation's updated_at.
 * @param {{ conversationId: string, role: 'user'|'assistant', content: string }} input
 */
export async function appendMessage({ conversationId, role, content }) {
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
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id',
      [conversationId, role, content]
    );
    await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
    await client.query('COMMIT');
    return rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Returns the most recent messages in a conversation, oldest first (ready to feed straight
 * into a Bedrock Converse `messages` array).
 * @param {string} conversationId
 * @param {number} limit
 * @returns {Promise<{role: string, content: string, createdAt: Date}[]>}
 */
export async function getRecentMessages(conversationId, limit = 12) {
  if (!conversationId) throw new Error('conversationId is required');
  const { rows } = await getPool().query(
    `SELECT role, content, created_at
       FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, limit]
  );
  return rows
    .map((row) => ({ role: row.role, content: row.content, createdAt: row.created_at }))
    .reverse();
}

/**
 * Saves a durable business-context note.
 * @param {{ businessId: string, content: string, source?: string }} input
 */
export async function saveNote({ businessId, content, source = null }) {
  if (!businessId) throw new Error('businessId is required');
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }
  const { rows } = await getPool().query(
    'INSERT INTO notes (business_id, content, source) VALUES ($1, $2, $3) RETURNING id',
    [businessId, content, source]
  );
  return rows[0].id;
}

/** @param {string} businessId */
export async function listNotes(businessId) {
  if (!businessId) throw new Error('businessId is required');
  const { rows } = await getPool().query(
    'SELECT id, content, source, created_at FROM notes WHERE business_id = $1 ORDER BY created_at DESC',
    [businessId]
  );
  return rows;
}

/**
 * Saves a draft artifact (e.g. a purchase-order draft) for later review.
 * @param {{ businessId: string, conversationId?: string, kind: string, payload: object }} input
 */
export async function saveDraft({ businessId, conversationId = null, kind, payload }) {
  if (!businessId) throw new Error('businessId is required');
  if (!kind) throw new Error('kind is required');
  if (!payload || typeof payload !== 'object') throw new Error('payload must be an object');
  const { rows } = await getPool().query(
    'INSERT INTO drafts (business_id, conversation_id, kind, payload) VALUES ($1, $2, $3, $4) RETURNING id',
    [businessId, conversationId, kind, JSON.stringify(payload)]
  );
  return rows[0].id;
}

/**
 * Inserts or replaces an embedded document (daily summary, menu item, glossary entry, ...).
 * @param {{ id?: string, businessId: string, docType: string, docDate?: string|null, content: string, metadata?: object, embedding: number[] }} input
 */
export async function upsertDocument({
  id = null,
  businessId,
  docType,
  docDate = null,
  content,
  metadata = {},
  embedding,
}) {
  if (!businessId) throw new Error('businessId is required');
  if (!docType) throw new Error('docType is required');
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }
  const vectorLiteral = toVectorLiteral(embedding);

  if (id) {
    const { rows } = await getPool().query(
      `UPSERT INTO documents (id, business_id, doc_type, doc_date, content, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [id, businessId, docType, docDate, content, JSON.stringify(metadata), vectorLiteral]
    );
    return rows[0].id;
  }

  const { rows } = await getPool().query(
    `INSERT INTO documents (business_id, doc_type, doc_date, content, metadata, embedding)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [businessId, docType, docDate, content, JSON.stringify(metadata), vectorLiteral]
  );
  return rows[0].id;
}

/**
 * Vector-searches documents for a business, nearest first by cosine distance.
 * @param {string} businessId
 * @param {number[]} queryEmbedding
 * @param {number} k
 * @returns {Promise<{id: string, docType: string, docDate: string|null, content: string, metadata: object, distance: number}[]>}
 */
export async function searchDocuments(businessId, queryEmbedding, k = 5) {
  if (!businessId) throw new Error('businessId is required');
  const vectorLiteral = toVectorLiteral(queryEmbedding);
  const { rows } = await getPool().query(
    `SELECT id, doc_type, doc_date, content, metadata, embedding <=> $2 AS distance
       FROM documents
      WHERE business_id = $1
      ORDER BY embedding <=> $2
      LIMIT $3`,
    [businessId, vectorLiteral, k]
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

/** Closes the shared pool. Call from scripts/tests that need a clean process exit. */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
