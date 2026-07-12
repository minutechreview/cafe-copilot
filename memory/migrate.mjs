#!/usr/bin/env node
// Applies schema.sql to the CockroachDB cluster in CRDB_CONNECTION_STRING. Substitutes the
// __EMBEDDING_DIM__ placeholder with EMBEDDING_DIM from .env.local (set by
// agent/scripts/find-embedding-model.mjs) since CockroachDB's VECTOR type is fixed-width.
// Idempotent — schema.sql is all CREATE ... IF NOT EXISTS, so re-running is safe.
// Run with: npm run migrate --workspace=memory  (or: node memory/migrate.mjs)
import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
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
  return template.replaceAll('__EMBEDDING_DIM__', String(embeddingDim));
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
    console.log('Migration applied: conversations, messages, notes, drafts, documents (+ vector index).');
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly (`node migrate.mjs`), not when imported for its
// renderSchema export (used by unit tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('migrate failed:', err?.message ?? err);
    process.exit(1);
  });
}
