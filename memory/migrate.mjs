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
    const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [file]);
    if (rows.length > 0) {
      continue;
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
