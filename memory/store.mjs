// CockroachDB-backed memory store for Café Copilot. All functions go through a single pg
// Pool built from CRDB_CONNECTION_STRING — this module is the only place in the codebase
// that talks SQL to the memory tables (schema.sql & migrations own their shape).
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';

const { Pool } = pg;

let pool;

const DEFAULT_POOL_MAX = 4;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const MAX_MEMORY_SEARCH_RESULTS = 20;
const MAX_LIST_NOTES_RESULTS = 50;
const MAX_ACTION_PAYLOAD_BYTES = 16 * 1024;
const MAX_ACTION_TEXT_BYTES = 2_000;
const TERMINAL_ACTION_STATES = new Set(['succeeded', 'rejected', 'expired', 'cancelled', 'stale', 'failed', 'reconciliation_pending']);
const RECONCILIATION_OBSERVATIONS = new Set(['audit_succeeded', 'audit_failed', 'audit_absent', 'audit_unavailable', 'policy_mismatch']);
const OPERATIONAL_COMMAND = /^ops\.(reminder|handover|exception_note)\.(create|complete|cancel|supersede)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
export const MAX_TRANSACTION_RETRIES = 3;
const TRANSACTION_RETRY_DELAYS_MS = Object.freeze([0, 5, 20]);

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

/** Action storage is intentionally unavailable to demo and legacy principals. */
export function normalizeActionPrincipal(principal) {
  const p = normalizePrincipal(principal);
  if (p.accessMode !== 'authenticated') {
    throw new Error('Copilot actions require an authenticated principal');
  }
  if (!UUID_RE.test(p.businessId) || !UUID_RE.test(p.actorId)) {
    throw new Error('Copilot actions require canonical UUID businessId and actorId');
  }
  return p;
}

function assertUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    throw new Error(`${name} must be a canonical UUID`);
  }
  return value.trim().toLowerCase();
}

function assertSha256(value, name) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function assertShortText(value, name, { min = 1, max = MAX_ACTION_TEXT_BYTES } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > max || normalized.length < min) {
    throw new Error(`${name} must be ${min}..${max} characters`);
  }
  return normalized;
}

function assertJsonObject(value, name, maxBytes = MAX_ACTION_PAYLOAD_BYTES) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const seen = new WeakSet();
  const rejectSensitive = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate)) throw new Error(`${name} must be JSON serializable`);
    seen.add(candidate);
    for (const [key, nested] of Object.entries(candidate)) {
      // Defense in depth: these values categorically do not belong in CRDB.
      const normalizedKey = key.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
      const secretSuffixes = ['pin', 'password', 'secret', 'capability', 'nonce', 'accesstoken', 'refreshtoken', 'authorization'];
      const secretPrefixes = ['secret', 'capability'];
      if (secretSuffixes.some((term) => normalizedKey.endsWith(term)) || secretPrefixes.some((term) => normalizedKey.startsWith(term))) {
        throw new Error(`${name} must not contain authentication, secret, capability, PIN, or nonce fields`);
      }
      rejectSensitive(nested);
    }
    seen.delete(candidate);
  };
  rejectSensitive(value);
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new Error(`${name} exceeds ${maxBytes} bytes`);
  }
  return json;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('normalizedPayload contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('normalizedPayload contains an unsupported JSON value');
}

export function hashCanonicalPayload(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function assertTimestamp(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
  return date.toISOString();
}

function assertActionKey(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.]{2,127}$/.test(value)) {
    throw new Error('actionKey must be a closed-registry style action key');
  }
  return value;
}

function mapProposal(row) {
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    actorUserId: row.actor_user_id,
    actionKey: row.action_key,
    actionVersion: row.action_version,
    policyVersion: row.policy_version,
    normalizedPayload: row.normalized_payload,
    payloadHash: row.payload_hash,
    targetSnapshotHash: row.target_snapshot_hash,
    expectedStateHash: row.expected_state_hash,
    parentActionId: row.parent_action_id,
    state: row.state,
    expiresAt: row.expires_at,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    terminalActionId: row.terminal_action_id,
    terminalCode: row.terminal_code,
    terminalMessage: row.terminal_message,
    terminalResult: row.terminal_result,
    reconciliationState: row.reconciliation_state,
    reconciledAt: row.reconciled_at,
    posAuditActionId: row.pos_audit_action_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function transactionRetryDelayMs(retryNumber) {
  if (!Number.isInteger(retryNumber) || retryNumber < 1) return 0;
  return TRANSACTION_RETRY_DELAYS_MS[Math.min(retryNumber - 1, TRANSACTION_RETRY_DELAYS_MS.length - 1)];
}

function waitForRetry(delayMs, signal) {
  throwIfAborted(signal);
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const error = new Error('Request deadline exceeded');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function withTransaction(work, signal) {
  throwIfAborted(signal);
  const client = await getPool().connect();
  const abort = bindAbort(client, signal);
  try {
    for (let attempt = 0; ; attempt += 1) {
      let began = false;
      try {
        throwIfAborted(signal);
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        began = true;
        const result = await work(client, attempt);
        throwIfAborted(signal);
        await client.query('COMMIT');
        throwIfAborted(signal);
        return result;
      } catch (err) {
        if (began && !abort.destroyed()) {
          try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
        }
        throwIfAborted(signal);
        if (err?.code !== '40001' || attempt >= MAX_TRANSACTION_RETRIES || abort.destroyed()) throw err;
        await waitForRetry(transactionRetryDelayMs(attempt + 1), signal);
      }
    }
  } finally {
    abort.cleanup();
    if (!abort.destroyed()) client.release();
  }
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

/**
 * Creates a principal-bound proposal and its first immutable event. Callers pass
 * only a SHA-256 nonce digest; this module never accepts or persists the nonce.
 * Retrying the same server-generated idempotencyKey returns the original proposal
 * only when the action and payload hash are identical.
 */
export async function createActionProposal(principal, input = {}, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const id = input.id ? assertUuid(input.id, 'proposalId') : randomUUID();
  const actionKey = assertActionKey(input.actionKey);
  const actionVersion = Number(input.actionVersion);
  const policyVersion = Number(input.policyVersion);
  if (!Number.isInteger(actionVersion) || actionVersion < 1) throw new Error('actionVersion must be a positive integer');
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 0) throw new Error('policyVersion must be a non-negative integer');
  const payload = assertJsonObject(input.normalizedPayload, 'normalizedPayload');
  const payloadHash = assertSha256(input.payloadHash, 'payloadHash');
  if (hashCanonicalPayload(input.normalizedPayload) !== payloadHash) {
    throw new Error('payloadHash does not match normalizedPayload');
  }
  const confirmationNonceHash = assertSha256(input.confirmationNonceHash, 'confirmationNonceHash');
  const idempotencyKey = assertShortText(input.idempotencyKey, 'idempotencyKey', { max: 128 });
  const expiresAt = assertTimestamp(input.expiresAt, 'expiresAt');
  const lifetimeMs = new Date(expiresAt).getTime() - Date.now();
  if (lifetimeMs <= 0 || lifetimeMs > 5 * 60_000) throw new Error('expiresAt must be within the five-minute proposal lifetime');
  const targetSnapshotHash = input.targetSnapshotHash == null ? null : assertSha256(input.targetSnapshotHash, 'targetSnapshotHash');
  const expectedStateHash = input.expectedStateHash == null ? null : assertSha256(input.expectedStateHash, 'expectedStateHash');
  const parentActionId = input.parentActionId == null ? null : assertUuid(input.parentActionId, 'parentActionId');

  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO copilot_action_proposals
         (id, business_id, actor_user_id, action_key, action_version, policy_version,
          normalized_payload, payload_hash, target_snapshot_hash, expected_state_hash,
          parent_action_id, idempotency_key, state, confirmation_nonce_hash, expires_at, event_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'proposed',$13,$14,1)
       ON CONFLICT (business_id, actor_user_id, action_key, idempotency_key) DO NOTHING
       RETURNING *`,
      [id, p.businessId, p.actorId, actionKey, actionVersion, policyVersion, payload, payloadHash,
        targetSnapshotHash, expectedStateHash, parentActionId, idempotencyKey, confirmationNonceHash, expiresAt]
    );
    if (inserted.rows.length > 0) {
      await client.query(
        `INSERT INTO copilot_action_events
           (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
         VALUES ($1,$2,$3,'proposed',$4,1)`,
        [id, p.businessId, p.actorId, JSON.stringify({ actionKey, policyVersion })]
      );
      return { proposal: mapProposal(inserted.rows[0]), created: true };
    }

    const existing = await client.query(
      `SELECT * FROM copilot_action_proposals
        WHERE business_id = $1 AND actor_user_id = $2 AND action_key = $3 AND idempotency_key = $4
        FOR UPDATE`,
      [p.businessId, p.actorId, actionKey, idempotencyKey]
    );
    const row = existing.rows[0];
    if (!row || row.payload_hash !== payloadHash || row.action_version !== actionVersion || String(row.policy_version) !== String(policyVersion)) {
      throw new Error('Idempotency key conflicts with a different action proposal');
    }
    return { proposal: mapProposal(row), created: false };
  }, signal);
}

/**
 * Creates a proposal or safely rebinds an exact live idempotent retry to a new
 * confirmation nonce digest. The raw nonce never enters this API or CockroachDB.
 */
export async function createOrRotateActionProposal(principal, input = {}, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const id = input.id ? assertUuid(input.id, 'proposalId') : randomUUID();
  const actionKey = assertActionKey(input.actionKey);
  const actionVersion = Number(input.actionVersion);
  const policyVersion = Number(input.policyVersion);
  if (!Number.isInteger(actionVersion) || actionVersion < 1) throw new Error('actionVersion must be a positive integer');
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 0) throw new Error('policyVersion must be a non-negative integer');
  const payload = assertJsonObject(input.normalizedPayload, 'normalizedPayload');
  const payloadHash = assertSha256(input.payloadHash, 'payloadHash');
  if (hashCanonicalPayload(input.normalizedPayload) !== payloadHash) {
    throw new Error('payloadHash does not match normalizedPayload');
  }
  const confirmationNonceHash = assertSha256(input.confirmationNonceHash, 'confirmationNonceHash');
  const idempotencyKey = assertShortText(input.idempotencyKey, 'idempotencyKey', { max: 128 });
  const expiresAt = assertTimestamp(input.expiresAt, 'expiresAt');
  const lifetimeMs = new Date(expiresAt).getTime() - Date.now();
  if (lifetimeMs <= 0 || lifetimeMs > 5 * 60_000) throw new Error('expiresAt must be within the five-minute proposal lifetime');
  const targetSnapshotHash = input.targetSnapshotHash == null ? null : assertSha256(input.targetSnapshotHash, 'targetSnapshotHash');
  const expectedStateHash = input.expectedStateHash == null ? null : assertSha256(input.expectedStateHash, 'expectedStateHash');
  const parentActionId = input.parentActionId == null ? null : assertUuid(input.parentActionId, 'parentActionId');

  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO copilot_action_proposals
         (id, business_id, actor_user_id, action_key, action_version, policy_version,
          normalized_payload, payload_hash, target_snapshot_hash, expected_state_hash,
          parent_action_id, idempotency_key, state, confirmation_nonce_hash, expires_at, event_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'proposed',$13,$14,1)
       ON CONFLICT (business_id, actor_user_id, action_key, idempotency_key) DO NOTHING
       RETURNING *`,
      [id, p.businessId, p.actorId, actionKey, actionVersion, policyVersion, payload, payloadHash,
        targetSnapshotHash, expectedStateHash, parentActionId, idempotencyKey, confirmationNonceHash, expiresAt]
    );
    if (inserted.rows.length > 0) {
      await client.query(
        `INSERT INTO copilot_action_events
           (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
         VALUES ($1,$2,$3,'proposed',$4,1)`,
        [id, p.businessId, p.actorId, JSON.stringify({ actionKey, policyVersion })]
      );
      return { proposal: mapProposal(inserted.rows[0]), nonceBound: true, created: true };
    }

    const rotated = await client.query(
      `UPDATE copilot_action_proposals
          SET confirmation_nonce_hash = $7, event_sequence = event_sequence + 1, updated_at = now()
        WHERE business_id = $1 AND actor_user_id = $2 AND action_key = $3 AND idempotency_key = $4
          AND payload_hash = $5 AND action_version = $6 AND policy_version = $8
          AND state = 'proposed' AND expires_at > now()
        RETURNING *`,
      [p.businessId, p.actorId, actionKey, idempotencyKey, payloadHash, actionVersion, confirmationNonceHash, policyVersion]
    );
    if (rotated.rows.length === 0) {
      throw new Error('Idempotent proposal retry conflicts, expired, or is no longer proposed');
    }
    const row = rotated.rows[0];
    await client.query(
      `INSERT INTO copilot_action_events
         (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,'confirmation_nonce_rotated',$4,$5)`,
      [row.id, p.businessId, p.actorId, JSON.stringify({ reason: 'exact_idempotent_retry' }), row.event_sequence]
    );
    return { proposal: mapProposal(row), nonceBound: true, created: false };
  }, signal);
}

/** Atomically consumes a presented nonce hash, claims a short-lived lease, and appends an event. */
export async function claimActionProposal(principal, input = {}, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const proposalId = assertUuid(input.proposalId, 'proposalId');
  const confirmationNonceHash = assertSha256(input.confirmationNonceHash, 'confirmationNonceHash');
  const rotatedNonceHash = assertSha256(input.rotatedNonceHash, 'rotatedNonceHash');
  const leaseId = input.leaseId ? assertUuid(input.leaseId, 'leaseId') : randomUUID();
  const leaseSeconds = input.leaseSeconds == null ? 60 : Number(input.leaseSeconds);
  const expectedPolicyVersion = Number(input.expectedPolicyVersion);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 120) throw new Error('leaseSeconds must be 1..120');
  if (!Number.isSafeInteger(expectedPolicyVersion) || expectedPolicyVersion < 0) {
    throw new Error('expectedPolicyVersion must be a non-negative integer');
  }

  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE copilot_action_proposals
          SET state = 'confirming', lease_id = $5,
              lease_expires_at = now() + ($6::TEXT || ' seconds')::INTERVAL,
              confirmation_nonce_hash = $7, event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3
          AND state = 'proposed' AND expires_at > now() AND confirmation_nonce_hash = $4
          AND policy_version = $8 AND action_key NOT LIKE 'ops.%'
        RETURNING *`,
      [proposalId, p.businessId, p.actorId, confirmationNonceHash, leaseId, leaseSeconds, rotatedNonceHash, expectedPolicyVersion]
    );
    if (updated.rows.length === 0) throw new Error('Proposal is unavailable, expired, or already claimed');
    const row = updated.rows[0];
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,'confirmation_claimed',$4,$5)`,
      [proposalId, p.businessId, p.actorId, JSON.stringify({ leaseId }), row.event_sequence]
    );
    return mapProposal(row);
  }, signal);
}

/** PIN rejection does not execute POS work: release the lease back to proposed with a new nonce digest. */
export async function releaseActionProposalAfterRejection(principal, input = {}, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const proposalId = assertUuid(input.proposalId, 'proposalId');
  const leaseId = assertUuid(input.leaseId, 'leaseId');
  const nextConfirmationNonceHash = assertSha256(input.nextConfirmationNonceHash, 'nextConfirmationNonceHash');
  const code = assertShortText(input.code || 'PIN_REJECTED', 'code', { max: 80 });

  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE copilot_action_proposals
          SET state = 'proposed', lease_id = NULL, lease_expires_at = NULL,
              confirmation_nonce_hash = $5, event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3
          AND state = 'confirming' AND lease_id = $4 AND expires_at > now()
        RETURNING *`,
      [proposalId, p.businessId, p.actorId, leaseId, nextConfirmationNonceHash]
    );
    if (updated.rows.length === 0) throw new Error('Proposal lease is unavailable');
    const row = updated.rows[0];
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,'confirmation_rejected',$4,$5)`,
      [proposalId, p.businessId, p.actorId, JSON.stringify({ code }), row.event_sequence]
    );
    return mapProposal(row);
  }, signal);
}

/**
 * Writes a terminal CRDB projection. `succeeded` is deliberately rejected unless
 * a caller-scoped, authoritative POS audit id was supplied by the executor.
 */
export async function recordActionTerminal(principal, input = {}, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const proposalId = assertUuid(input.proposalId, 'proposalId');
  const leaseId = assertUuid(input.leaseId, 'leaseId');
  const state = input.state;
  if (!TERMINAL_ACTION_STATES.has(state)) throw new Error('state must be a terminal action state');
  const code = assertShortText(input.code, 'code', { max: 80 });
  const message = input.message == null ? null : assertShortText(input.message, 'message', { max: 500 });
  const actionId = input.actionId == null ? null : assertUuid(input.actionId, 'actionId');
  const posAuditActionId = input.posAuditActionId == null ? null : assertUuid(input.posAuditActionId, 'posAuditActionId');
  if (state === 'succeeded' && (!input.authoritativePosAudit || !actionId || !posAuditActionId)) {
    throw new Error('POS success requires an authoritative POS audit action id');
  }
  if (state !== 'succeeded' && input.authoritativePosAudit) {
    throw new Error('authoritativePosAudit is only valid for an observed POS success');
  }

  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE copilot_action_proposals
          SET state = $5, terminal_action_id = $6, terminal_code = $7, terminal_message = $8,
              pos_audit_action_id = CASE WHEN $9 THEN $10 ELSE pos_audit_action_id END,
              reconciliation_state = CASE WHEN $9 THEN 'observed' ELSE reconciliation_state END,
              reconciled_at = CASE WHEN $9 THEN now() ELSE reconciled_at END,
              lease_id = NULL,
              lease_expires_at = CASE WHEN $5 = 'reconciliation_pending' THEN lease_expires_at ELSE NULL END,
              event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3
          AND state = 'confirming' AND lease_id = $4
        RETURNING *`,
      [proposalId, p.businessId, p.actorId, leaseId, state, actionId, code, message, Boolean(input.authoritativePosAudit), posAuditActionId]
    );
    if (updated.rows.length === 0) throw new Error('Proposal lease is unavailable');
    const row = updated.rows[0];
    if (input.authoritativePosAudit) {
      await client.query(
        `INSERT INTO copilot_action_reconciliation_observations
           (proposal_id, business_id, actor_user_id, observation, action_id, pos_audit_action_id, result_code, metadata)
         VALUES ($1,$2,$3,'audit_succeeded',$4,$5,$6,$7)`,
        [proposalId, p.businessId, p.actorId, actionId, posAuditActionId, code, JSON.stringify({ source: 'verified_executor_response' })]
      );
    }
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [proposalId, p.businessId, p.actorId, `terminal_${state}`, JSON.stringify({ code, actionId, posAuditActionId }), row.event_sequence]
    );
    return mapProposal(row);
  }, signal);
}

/** Expires only an unclaimed proposal; a confirming lease must be reconciled, never re-executed. */
export async function expireActionProposal(principal, proposalId, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const id = assertUuid(proposalId, 'proposalId');
  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE copilot_action_proposals
          SET state = 'expired', terminal_code = 'PROPOSAL_EXPIRED', lease_id = NULL, lease_expires_at = NULL,
              event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 AND state = 'proposed' AND expires_at <= now()
        RETURNING *`, [id, p.businessId, p.actorId]
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0];
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,'expired','{}',$4)`, [id, p.businessId, p.actorId, row.event_sequence]
    );
    return mapProposal(row);
  }, signal);
}

/** Cancels a still-unclaimed proposal; terminal rows cannot be rewritten. */
export async function cancelActionProposal(principal, proposalId, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const id = assertUuid(proposalId, 'proposalId');
  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE copilot_action_proposals
          SET state = 'cancelled', terminal_code = 'CANCELLED', event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 AND state = 'proposed'
        RETURNING *`, [id, p.businessId, p.actorId]
    );
    if (updated.rows.length === 0) throw new Error('Proposal cannot be cancelled');
    const row = updated.rows[0];
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,'cancelled','{}',$4)`, [id, p.businessId, p.actorId, row.event_sequence]
    );
    return mapProposal(row);
  }, signal);
}

/** Marks an expired lease as reconciliation_pending and records no invented POS result. */
export async function recoverExpiredActionLease(principal, proposalId, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const id = assertUuid(proposalId, 'proposalId');
  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE copilot_action_proposals
          SET state = 'reconciliation_pending', terminal_code = 'LEASE_EXPIRED', reconciliation_state = 'pending',
              lease_id = NULL, event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3
          AND state = 'confirming' AND lease_expires_at <= now()
        RETURNING *`, [id, p.businessId, p.actorId]
    );
    if (updated.rows.length === 0) return null;
    const row = updated.rows[0];
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,'lease_expired_reconciliation_pending','{}',$4)`, [id, p.businessId, p.actorId, row.event_sequence]
    );
    return mapProposal(row);
  }, signal);
}

/** Records caller-scoped POS-audit evidence and updates the display projection only from that evidence. */
export async function recordActionReconciliation(principal, input = {}, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const proposalId = assertUuid(input.proposalId, 'proposalId');
  const observation = input.observation;
  if (!RECONCILIATION_OBSERVATIONS.has(observation)) throw new Error('Unsupported reconciliation observation');
  const actionId = input.actionId == null ? null : assertUuid(input.actionId, 'actionId');
  const posAuditActionId = input.posAuditActionId == null ? null : assertUuid(input.posAuditActionId, 'posAuditActionId');
  const resultCode = input.resultCode == null ? null : assertShortText(input.resultCode, 'resultCode', { max: 80 });
  const metadata = assertJsonObject(input.metadata || {}, 'reconciliation metadata', 4 * 1024);
  if ((observation === 'audit_succeeded' || observation === 'audit_failed') && (!input.authoritativeAudit || !actionId || !posAuditActionId)) {
    throw new Error('Audit terminal observations require authoritative caller-scoped evidence');
  }

  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM copilot_action_proposals
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 FOR UPDATE`,
      [proposalId, p.businessId, p.actorId]
    );
    if (current.rows.length === 0) throw new Error('Proposal not found');
    const currentRow = current.rows[0];
    const activeLease = (currentRow.state === 'confirming' || currentRow.state === 'reconciliation_pending')
      && (!currentRow.lease_expires_at || new Date(currentRow.lease_expires_at).getTime() > Date.now());
    const authoritativeCommittedSuccess = observation === 'audit_succeeded' && input.authoritativeAudit === true;
    if (activeLease && !authoritativeCommittedSuccess) {
      throw new Error('Active confirmation lease cannot be reconciled');
    }
    await client.query(
      `INSERT INTO copilot_action_reconciliation_observations
         (proposal_id, business_id, actor_user_id, observation, action_id, pos_audit_action_id, result_code, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [proposalId, p.businessId, p.actorId, observation, actionId, posAuditActionId, resultCode, metadata]
    );
    const state = observation === 'audit_succeeded' ? 'succeeded'
      : observation === 'audit_failed' ? 'failed' : 'reconciliation_pending';
    const updated = await client.query(
      `UPDATE copilot_action_proposals
          SET state = $4, terminal_action_id = CASE WHEN $5 THEN COALESCE(terminal_action_id, $6) ELSE terminal_action_id END,
              terminal_code = COALESCE($8, terminal_code), pos_audit_action_id = COALESCE($7, pos_audit_action_id),
              reconciliation_state = CASE WHEN $5 THEN 'observed' ELSE 'pending' END, reconciled_at = now(),
              lease_id = NULL, lease_expires_at = NULL, event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3
          AND state IN ('confirming', 'reconciliation_pending')
          AND (lease_expires_at <= now() OR $9)
        RETURNING *`,
      [proposalId, p.businessId, p.actorId, state, Boolean(input.authoritativeAudit), actionId, posAuditActionId, resultCode, authoritativeCommittedSuccess]
    );
    if (updated.rows.length === 0) throw new Error('Proposal is not reconcilable');
    const row = updated.rows[0];
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [proposalId, p.businessId, p.actorId, `reconciliation_${observation}`, JSON.stringify({ actionId, posAuditActionId, resultCode }), row.event_sequence]
    );
    return mapProposal(row);
  }, signal);
}

/** Exact actor/business status lookup. It intentionally never exposes nonce hashes. */
export async function getActionProposal(principal, proposalId, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const id = assertUuid(proposalId, 'proposalId');
  const { rows } = await runQuery(
    `SELECT id, business_id, actor_user_id, action_key, action_version, policy_version, normalized_payload, payload_hash,
            target_snapshot_hash, expected_state_hash, parent_action_id, state, expires_at, lease_id, lease_expires_at,
            terminal_action_id, terminal_code, terminal_message, terminal_result, reconciliation_state, reconciled_at, pos_audit_action_id,
            created_at, updated_at
       FROM copilot_action_proposals
      WHERE id = $1 AND business_id = $2 AND actor_user_id = $3`,
    [id, p.businessId, p.actorId], signal
  );
  return mapProposal(rows[0]);
}

function parseOperationalCommand(commandKey) {
  const match = OPERATIONAL_COMMAND.exec(commandKey || '');
  if (!match) throw new Error('commandKey must be an allowlisted passive operational command');
  return { recordType: match[1], verb: match[2] };
}

function mapOperationalRecord(row) {
  if (!row) return null;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Operational record version is not a safe positive integer');
  }
  return {
    id: row.id,
    businessId: row.business_id,
    createdBy: row.created_by,
    createdActionId: row.created_action_id,
    createdProposalId: row.created_proposal_id,
    recordType: row.record_type,
    title: row.title,
    body: row.body,
    targetKind: row.target_kind,
    targetId: row.target_id,
    dueAt: row.due_at,
    status: row.status,
    version,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
  };
}

/** Narrow tenant-scoped discovery for backend operational-record resolution. */
export async function findOperationalRecords(
  principal,
  { query, statuses = ['open'], limit = 10 } = {},
  { signal } = {}
) {
  const p = normalizeActionPrincipal(principal);
  const normalizedQuery = assertShortText(query, 'query', { max: 120 });
  const allowedStatuses = new Set(['open', 'completed', 'cancelled', 'superseded']);
  if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > allowedStatuses.size) {
    throw new Error('statuses must contain 1..4 allowlisted operational statuses');
  }
  const normalizedStatuses = [...new Set(statuses.map((status) => {
    if (typeof status !== 'string' || !allowedStatuses.has(status)) {
      throw new Error('statuses contains an unsupported operational status');
    }
    return status;
  }))];
  const numericLimit = Number(limit);
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 10) {
    throw new Error('limit must be 1..10');
  }
  const escapedPattern = `%${normalizedQuery.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const { rows } = await runQuery(
    `SELECT id, business_id, record_type, title, status, version
       FROM copilot_operational_records
      WHERE business_id = $1 AND status = ANY($2::TEXT[])
        AND (title ILIKE $3 ESCAPE '\\' OR record_type ILIKE $3 ESCAPE '\\')
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [p.businessId, normalizedStatuses, escapedPattern, numericLimit], signal
  );
  return rows.map((row) => {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error('Operational record version is not a safe positive integer');
    }
    return {
      id: row.id,
      businessId: row.business_id,
      recordType: row.record_type,
      title: row.title,
      status: row.status,
      version,
    };
  });
}

/**
 * Business-scoped passive record lookup for a backend that has already verified
 * the authenticated principal's active owner/manager membership.
 */
export async function getOperationalRecord(principal, id, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const recordId = assertUuid(id, 'operationalRecordId');
  const { rows } = await runQuery(
    `SELECT id, business_id, created_by, created_action_id, created_proposal_id,
            record_type, title, body, target_kind, target_id, due_at, status, version,
            supersedes_id, created_at, completed_at, completed_by, cancelled_at, cancelled_by
       FROM copilot_operational_records
      WHERE id = $1 AND business_id = $2`,
    [recordId, p.businessId], signal
  );
  return mapOperationalRecord(rows[0]);
}

function assertExactObjectKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${name} contains unknown field(s): ${unknown.join(', ')}`);
}

/**
 * Claims and executes a passive record proposal in one SERIALIZABLE Cockroach
 * transaction. Mutation arguments come exclusively from the persisted, hashed
 * normalized_payload; callers provide only proposal confirmation material.
 */
export async function claimAndExecuteOperationalRecordCommand(principal, input = {}, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const proposalId = assertUuid(input.proposalId, 'proposalId');
  const actionId = assertUuid(input.actionId, 'actionId');
  const confirmationNonceHash = assertSha256(input.confirmationNonceHash, 'confirmationNonceHash');
  const rotatedNonceHash = assertSha256(input.rotatedNonceHash, 'rotatedNonceHash');
  const expectedPolicyVersion = Number(input.expectedPolicyVersion);
  if (!Number.isSafeInteger(expectedPolicyVersion) || expectedPolicyVersion < 0) {
    throw new Error('expectedPolicyVersion must be a non-negative integer');
  }
  const leaseId = randomUUID();

  return withTransaction(async (client) => {
    const proposal = await client.query(
      `SELECT * FROM copilot_action_proposals
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 FOR UPDATE`,
      [proposalId, p.businessId, p.actorId]
    );
    const proposalRow = proposal.rows[0];
    if (!proposalRow) throw new Error('Proposal not found');

    const prior = await client.query(
      `SELECT e.result_snapshot
         FROM copilot_operational_record_events e
        WHERE e.business_id = $1 AND e.proposal_id = $2 AND e.action_id = $3`,
      [p.businessId, proposalId, actionId]
    );
    if (prior.rows.length > 0) {
      const snapshot = typeof prior.rows[0].result_snapshot === 'string'
        ? JSON.parse(prior.rows[0].result_snapshot) : prior.rows[0].result_snapshot;
      return { ...snapshot, replayed: true };
    }

    const commandKey = proposalRow.action_key;
    const { recordType, verb } = parseOperationalCommand(commandKey);
    const payload = typeof proposalRow.normalized_payload === 'string'
      ? JSON.parse(proposalRow.normalized_payload) : proposalRow.normalized_payload;
    assertJsonObject(payload, 'persisted normalizedPayload');
    if (hashCanonicalPayload(payload) !== proposalRow.payload_hash) {
      throw new Error('Persisted proposal payload hash mismatch');
    }
    const allowedKeys = verb === 'create'
      ? ['recordType', 'verb', 'title', 'body', 'targetKind', 'targetId', 'dueAt']
      : verb === 'supersede'
        ? ['recordType', 'verb', 'recordId', 'expectedVersion', 'title', 'body', 'targetKind', 'targetId', 'dueAt']
        : ['recordType', 'verb', 'recordId', 'expectedVersion'];
    assertExactObjectKeys(payload, allowedKeys, 'persisted normalizedPayload');
    if (payload.recordType !== recordType || payload.verb !== verb) {
      throw new Error('Persisted operational recordType/verb does not match proposal action key');
    }
    const recordId = payload.recordId == null ? null : assertUuid(payload.recordId, 'normalizedPayload.recordId');
    const expectedVersion = payload.expectedVersion == null ? null : Number(payload.expectedVersion);
    if (verb !== 'create' && (!recordId || !Number.isInteger(expectedVersion) || expectedVersion < 1)) {
      throw new Error('Persisted operational transition requires recordId and positive expectedVersion');
    }
    const title = payload.title == null ? null : assertShortText(payload.title, 'normalizedPayload.title', { max: 120 });
    const body = payload.body == null ? null : assertShortText(payload.body, 'normalizedPayload.body', { max: 2_000 });
    const targetKind = payload.targetKind == null ? null : assertShortText(payload.targetKind, 'normalizedPayload.targetKind', { max: 80 });
    const targetId = payload.targetId == null ? null : assertUuid(payload.targetId, 'normalizedPayload.targetId');
    const dueAt = payload.dueAt == null ? null : assertTimestamp(payload.dueAt, 'normalizedPayload.dueAt');
    if ((verb === 'create' || verb === 'supersede') && (!title || !body)) {
      throw new Error('Persisted create/supersede payload requires title and body');
    }

    const claimed = await client.query(
      `UPDATE copilot_action_proposals
          SET state = 'confirming', lease_id = $5, lease_expires_at = now() + INTERVAL '60 seconds',
              confirmation_nonce_hash = $6, event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3 AND state = 'proposed'
          AND expires_at > now() AND confirmation_nonce_hash = $4 AND policy_version = $7
        RETURNING event_sequence`,
      [proposalId, p.businessId, p.actorId, confirmationNonceHash, leaseId, rotatedNonceHash, expectedPolicyVersion]
    );
    if (claimed.rows.length === 0) throw new Error('Proposal is unavailable, expired, stale-policy, or already claimed');
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,'confirmation_claimed',$4,$5)`,
      [proposalId, p.businessId, p.actorId, JSON.stringify({ leaseId, passive: true }), claimed.rows[0].event_sequence]
    );

    let record;
    let supersededRecordId = null;
    if (verb === 'create') {
      const created = await client.query(
        `INSERT INTO copilot_operational_records
           (business_id, created_by, created_action_id, created_proposal_id, record_type, title, body,
            target_kind, target_id, due_at, status, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',1)
         RETURNING *`,
        [p.businessId, p.actorId, actionId, proposalId, recordType, title, body, targetKind, targetId, dueAt]
      );
      record = created.rows[0];
    } else if (verb === 'complete' || verb === 'cancel') {
      const status = verb === 'complete' ? 'completed' : 'cancelled';
      const changed = await client.query(
        `UPDATE copilot_operational_records
            SET status = $5, version = version + 1,
                completed_at = CASE WHEN $5 = 'completed' THEN now() ELSE completed_at END,
                completed_by = CASE WHEN $5 = 'completed' THEN $4 ELSE completed_by END,
                cancelled_at = CASE WHEN $5 = 'cancelled' THEN now() ELSE cancelled_at END,
                cancelled_by = CASE WHEN $5 = 'cancelled' THEN $4 ELSE cancelled_by END
          WHERE id = $1 AND business_id = $2 AND record_type = $3 AND status = 'open' AND version = $6
          RETURNING *`,
        [recordId, p.businessId, recordType, p.actorId, status, expectedVersion]
      );
      if (changed.rows.length === 0) throw new Error('Operational record is unavailable or has changed');
      record = changed.rows[0];
    } else {
      const old = await client.query(
        `UPDATE copilot_operational_records
            SET status = 'superseded', version = version + 1
          WHERE id = $1 AND business_id = $2 AND record_type = $3 AND status = 'open' AND version = $4
          RETURNING *`,
        [recordId, p.businessId, recordType, expectedVersion]
      );
      if (old.rows.length === 0) throw new Error('Operational record is unavailable or has changed');
      supersededRecordId = old.rows[0].id;
      const created = await client.query(
        `INSERT INTO copilot_operational_records
           (business_id, created_by, created_action_id, created_proposal_id, record_type, title, body,
            target_kind, target_id, due_at, status, version, supersedes_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',1,$11)
         RETURNING *`,
        [p.businessId, p.actorId, actionId, proposalId, recordType, title, body, targetKind, targetId, dueAt, old.rows[0].id]
      );
      record = created.rows[0];
    }

    const recordSnapshot = mapOperationalRecord(record);
    const terminalResult = {
      schemaVersion: 1,
      proposalId,
      actionId,
      action: commandKey,
      status: 'succeeded',
      code: 'OK',
      result: { record: recordSnapshot, supersededRecordId },
    };
    await client.query(
      `INSERT INTO copilot_operational_record_events
         (record_id, business_id, proposal_id, action_id, actor_user_id, command_key, metadata, result_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [record.id, p.businessId, proposalId, actionId, p.actorId, commandKey,
        JSON.stringify({ recordType, verb, supersededRecordId, resultingRecordId: record.id, resultingVersion: record.version }),
        JSON.stringify(terminalResult)]
    );
    const terminal = await client.query(
      `UPDATE copilot_action_proposals
          SET state = 'succeeded', terminal_action_id = $4, terminal_code = 'OK', terminal_result = $6,
              lease_id = NULL, lease_expires_at = NULL, event_sequence = event_sequence + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND actor_user_id = $3
          AND state = 'confirming' AND lease_id = $5
        RETURNING *`,
      [proposalId, p.businessId, p.actorId, actionId, leaseId, JSON.stringify(terminalResult)]
    );
    if (terminal.rows.length === 0) throw new Error('Proposal lease is unavailable');
    await client.query(
      `INSERT INTO copilot_action_events (proposal_id, business_id, actor_user_id, event_type, metadata, sequence)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [proposalId, p.businessId, p.actorId, `operational_${verb}_completed`,
        JSON.stringify({ actionId, recordId: record.id, commandKey }), terminal.rows[0].event_sequence]
    );
    return { ...terminalResult, proposal: mapProposal(terminal.rows[0]), replayed: false };
  }, signal);
}

// Backward-compatible export name; semantics are now combined claim-and-execute.
export const executeOperationalRecordCommand = claimAndExecuteOperationalRecordCommand;

/** Inputs for the API's deterministic POS+passive merged-history projection. */
export async function listOperationalActionHistory(principal, { asOf, beforeOccurredAt, beforeSourceRank, beforeActionId, limit = 20 } = {}, { signal } = {}) {
  const p = normalizeActionPrincipal(principal);
  const numericLimit = Number(limit);
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 50) throw new Error('limit must be 1..50');
  const asOfTimestamp = assertTimestamp(asOf || new Date(), 'asOf');
  const beforeTimestamp = beforeOccurredAt == null ? asOfTimestamp : assertTimestamp(beforeOccurredAt, 'beforeOccurredAt');
  const cursorSourceRank = beforeSourceRank == null ? 2 : Number(beforeSourceRank);
  if (!Number.isInteger(cursorSourceRank) || cursorSourceRank < 0 || cursorSourceRank > 2) {
    throw new Error('beforeSourceRank must be 0..2');
  }
  const cursorActionId = beforeActionId == null ? 'ffffffff-ffff-5fff-bfff-ffffffffffff' : assertUuid(beforeActionId, 'beforeActionId');
  const { rows } = await runQuery(
    `SELECT e.action_id, e.proposal_id, e.command_key, e.occurred_at, e.metadata,
            e.result_snapshot, 0::INT AS source_rank
       FROM copilot_operational_record_events e
      WHERE e.business_id = $1 AND e.occurred_at <= $2
        AND (e.occurred_at < $3 OR
             (e.occurred_at = $3 AND (0 < $4 OR (0 = $4 AND e.action_id < $5))))
      ORDER BY e.occurred_at DESC, source_rank DESC, e.action_id DESC
      LIMIT $6`,
    [p.businessId, asOfTimestamp, beforeTimestamp, cursorSourceRank, cursorActionId, numericLimit], signal
  );
  return rows.map((row) => {
    const resultSnapshot = typeof row.result_snapshot === 'string'
      ? JSON.parse(row.result_snapshot) : row.result_snapshot;
    if (!resultSnapshot || typeof resultSnapshot !== 'object' || !resultSnapshot.result?.record) {
      throw new Error('Operational history event has no immutable result snapshot');
    }
    return {
      source: 'passive', sourceRank: row.source_rank ?? 0, actionId: row.action_id, proposalId: row.proposal_id,
      commandKey: row.command_key, occurredAt: row.occurred_at, metadata: row.metadata,
      resultSnapshot, record: resultSnapshot.result.record,
    };
  });
}

/** Closes the shared pool. */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
