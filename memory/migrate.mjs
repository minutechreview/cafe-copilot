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

export async function runPreflightChecks(client) {
  const { rows: draftRows } = await client.query(`
    SELECT COUNT(*)::int AS count
      FROM drafts d
      LEFT JOIN conversations c ON d.conversation_id = c.id
     WHERE d.conversation_id IS NOT NULL
       AND (c.id IS NULL OR d.business_id <> c.business_id)
  `);
  const invalidDraftsCount = draftRows[0]?.count || 0;

  const { rows: docRows } = await client.query(`
    SELECT COUNT(*)::int AS count FROM (
      SELECT business_id, doc_type, doc_date
        FROM documents
       WHERE doc_date IS NOT NULL
       GROUP BY business_id, doc_type, doc_date
      HAVING COUNT(*) > 1
    ) dupes
  `);
  const duplicateDocsCount = docRows[0]?.count || 0;

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

export async function runMigrations({ client, embeddingDim, migrationsDir = path.join(REPO_ROOT, 'memory', 'migrations'), schemaPath = path.join(REPO_ROOT, 'memory', 'schema.sql') } = {}) {
  if (!embeddingDim) {
    throw new Error('EMBEDDING_DIM is not configured — run find-embedding-model first');
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const baseSqlTemplate = readFileSync(schemaPath, 'utf8');
  const baseSql = baseSqlTemplate.replaceAll('__EMBEDDING_DIM__', String(embeddingDim));

  await client.query('BEGIN');
  try {
    await client.query(baseSql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
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

    const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [file]);
    if (rows.length > 0) {
      continue;
    }

    if (file.startsWith('001_')) {
      await runPreflightChecks(client);
    }

    const migrationContent = readFileSync(path.join(migrationsDir, file), 'utf8');
    const migrationSql = migrationContent.replaceAll('__EMBEDDING_DIM__', String(embeddingDim));

    await client.query('BEGIN');
    try {
      await client.query(migrationSql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err?.message ?? err}`);
    }
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
