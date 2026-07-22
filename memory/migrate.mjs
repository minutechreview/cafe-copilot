#!/usr/bin/env node
// Applies schema.sql and all numbered migrations in memory/migrations/ to the CockroachDB
// cluster in CRDB_CONNECTION_STRING. Substitutes the __EMBEDDING_DIM__ placeholder.
// Idempotent — safe to re-run.
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
  } catch {
    // migrations directory optional
  }

  return `${baseSql}\n${migrationSql}`;
}

async function main() {
  const connectionString = process.env.CRDB_CONNECTION_STRING;
  if (!connectionString) {
    console.error('CRDB_CONNECTION_STRING is not set in .env.local.');
    process.exit(1);
  }

  const sql = renderSchema({ embeddingDim: process.env.EMBEDDING_DIM });

  const pool = new Pool({ connectionString });
  try {
    await pool.query(sql);
    console.log('Migration applied: conversations, messages, notes, drafts, documents (+ vector index & principal ownership).');
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('migrate failed:', err?.message ?? err);
    process.exit(1);
  });
}
