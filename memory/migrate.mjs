#!/usr/bin/env node
// Applies schema.sql and all numbered migrations in memory/migrations/ to the CockroachDB
// cluster in CRDB_CONNECTION_STRING using a schema_migrations ledger.
// Substitutes the __EMBEDDING_DIM__ placeholder. Idempotent — safe to re-run.
import { config as loadEnv } from 'dotenv';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(REPO_ROOT, '.env.local') });

const { Pool } = pg;
const ZERO_PADDED_REGEX = /^\d{3}_[a-z0-9_-]+\.sql$/i;

/**
 * Splits a SQL file string into individual executable SQL statements, stripping
 * single-line comments (-- ...) and blank lines while preserving multi-line statements.
 */
export function splitSqlStatements(sqlContent) {
  const lines = sqlContent
    .split('\n')
    .map((line) => {
      const commentIdx = line.indexOf('--');
      if (commentIdx !== -1) {
        return line.slice(0, commentIdx);
      }
      return line;
    });

  const cleaned = lines.join('\n');
  return cleaned
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

export async function isMigrationPending(client, version) {
  const { rows } = await client.query(`SELECT to_regclass('public.schema_migrations') AS rel`);
  const hasLedger = Boolean(rows[0]?.rel);

  if (!hasLedger) {
    return true;
  }

  const { rows: versionRows } = await client.query(
    'SELECT version FROM schema_migrations WHERE version = $1',
    [version]
  );
  return versionRows.length === 0;
}

export async function runPreflightChecks(client) {
  const { rows: draftsExists } = await client.query(`SELECT to_regclass('public.drafts') AS rel`);
  const { rows: docsExists } = await client.query(`SELECT to_regclass('public.documents') AS rel`);

  const hasDrafts = Boolean(draftsExists[0]?.rel);
  const hasDocs = Boolean(docsExists[0]?.rel);

  if (!hasDrafts && !hasDocs) {
    return;
  }

  let invalidDraftsCount = 0;
  if (hasDrafts) {
    const { rows: draftRows } = await client.query(`
      SELECT COUNT(*)::int AS count
        FROM drafts d
        LEFT JOIN conversations c ON d.conversation_id = c.id
       WHERE d.conversation_id IS NOT NULL
         AND (c.id IS NULL OR d.business_id <> c.business_id)
    `);
    invalidDraftsCount = draftRows[0]?.count || 0;
  }

  let duplicateDocsCount = 0;
  if (hasDocs) {
    const { rows: docRows } = await client.query(`
      SELECT COUNT(*)::int AS count FROM (
        SELECT business_id, doc_type, doc_date
          FROM documents
         WHERE doc_date IS NOT NULL
         GROUP BY business_id, doc_type, doc_date
        HAVING COUNT(*) > 1
      ) dupes
    `);
    duplicateDocsCount = docRows[0]?.count || 0;
  }

  if (invalidDraftsCount > 0 || duplicateDocsCount > 0) {
    throw new Error(
      `Preflight check failed: found ${invalidDraftsCount} invalid draft(s) with mismatched conversation references and ${duplicateDocsCount} duplicate dated document group(s). Action required before migration 001.`
    );
  }
}

export function renderSchema({ embeddingDim, schemaPath = path.join(REPO_ROOT, 'memory', 'schema.sql') } = {}) {
  if (!embeddingDim) {
    throw new Error('EMBEDDING_DIM is not configured — run find-embedding-model first');
  }
  const template = readFileSync(schemaPath, 'utf8');
  const baseSql = template.replaceAll('__EMBEDDING_DIM__', String(embeddingDim));

  const migrationsDir = path.join(REPO_ROOT, 'memory', 'migrations');
  let migrationSql = '';
  try {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (!ZERO_PADDED_REGEX.test(file)) {
        throw new Error(`Invalid migration filename format: "${file}". Filenames must be zero-padded 3-digit numbers like "001_name.sql".`);
      }
      const content = readFileSync(path.join(migrationsDir, file), 'utf8');
      migrationSql += `\n-- Migration: ${file}\n` + content.replaceAll('__EMBEDDING_DIM__', String(embeddingDim));
    }
  } catch (err) {
    throw new Error(`Failed to read migrations directory: ${err?.message ?? err}`);
  }

  return `${baseSql}\n${migrationSql}`;
}

function isCreateTableStatement(statement) {
  return /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(statement.trim());
}

function isAllowedDeferredBaseStatement(statement) {
  return /^CREATE\s+(?:UNIQUE\s+|VECTOR\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i.test(statement.trim());
}

function classifyBaseSchema({ embeddingDim, schemaPath }) {
  const baseSqlTemplate = readFileSync(schemaPath, 'utf8');
  const baseSql = baseSqlTemplate.replaceAll('__EMBEDDING_DIM__', String(embeddingDim));
  const baseStatements = splitSqlStatements(baseSql);
  const bootstrapStatements = baseStatements.filter(isCreateTableStatement);
  const deferredBaseStatements = baseStatements.filter((stmt) => !isCreateTableStatement(stmt));

  for (const stmt of deferredBaseStatements) {
    if (!isAllowedDeferredBaseStatement(stmt)) {
      throw new Error(
        `Unsupported non-table base schema statement. Only idempotent CREATE INDEX IF NOT EXISTS statements may be deferred: ${stmt.slice(0, 80)}`
      );
    }
  }

  return { bootstrapStatements, deferredBaseStatements };
}

export async function runMigrations({ client, embeddingDim, migrationsDir = path.join(REPO_ROOT, 'memory', 'migrations'), schemaPath = path.join(REPO_ROOT, 'memory', 'schema.sql') } = {}) {
  if (!embeddingDim) {
    throw new Error('EMBEDDING_DIM is not configured — run find-embedding-model first');
  }

  let files;
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    throw new Error(`Failed to read migrations directory: ${err?.message ?? err}`);
  }

  for (const file of files) {
    if (!ZERO_PADDED_REGEX.test(file)) {
      throw new Error(`Invalid migration filename format: "${file}". Filenames must be zero-padded 3-digit numbers like "001_name.sql".`);
    }
  }

  // Validate the split before issuing even a read query. The runner can only
  // defer idempotent indexes; a future schema change must be deliberately
  // placed in a numbered migration rather than silently reordered.
  const { bootstrapStatements, deferredBaseStatements } = classifyBaseSchema({
    embeddingDim,
    schemaPath,
  });

  // Discover if 001 is pending with ZERO SQL MUTATION
  const migration001File = files.find((f) => f.startsWith('001_'));
  let is001Pending = false;
  if (migration001File) {
    is001Pending = await isMigrationPending(client, migration001File);
  }

  // Run read-only preflight checks BEFORE any DDL or mutation statement
  if (is001Pending) {
    await runPreflightChecks(client);
  }

  // Ledger table creation (idempotent statement)
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Bootstrap tables before migrations, but defer base indexes until afterwards.
  //
  // `CREATE TABLE IF NOT EXISTS` does not evolve an existing table. Running the
  // complete current schema against an old installation would therefore try to
  // create an actor_id/access_mode index before migration 001 adds those
  // columns. Keeping table bootstrapping separate lets 001 safely evolve both
  // fresh and legacy catalog shapes. This also makes a retry safe when a prior
  // failed run created an empty schema_migrations ledger.
  for (const stmt of bootstrapStatements) {
    await client.query(stmt);
  }

  // Execute each pending migration file as individual statements (CockroachDB autocommit safe)
  for (const file of files) {
    const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [file]);
    if (rows.length > 0) {
      continue;
    }

    const migrationContent = readFileSync(path.join(migrationsDir, file), 'utf8');
    const migrationSql = migrationContent.replaceAll('__EMBEDDING_DIM__', String(embeddingDim));
    const statements = splitSqlStatements(migrationSql);

    for (const stmt of statements) {
      await client.query(stmt);
    }

    // Write to ledger ONLY after all individual migration statements succeeded
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [file]
    );
  }

  // Indexes are deliberately last: principal-aware ones are valid only after
  // migration 001 has added the corresponding columns to legacy tables.
  for (const stmt of deferredBaseStatements) {
    await client.query(stmt);
  }
}

async function main() {
  const connectionString = process.env.CRDB_CONNECTION_STRING;
  if (!connectionString) {
    console.error('CRDB_CONNECTION_STRING is not set in .env.local.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await runMigrations({ client, embeddingDim: process.env.EMBEDDING_DIM });
    console.log('Migration applied: conversations, messages, notes, drafts, documents (+ ledger & principal ownership).');
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('migrate failed:', err?.message ?? err);
    process.exit(1);
  });
}
