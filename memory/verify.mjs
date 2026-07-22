#!/usr/bin/env node
// Live end-to-end proof that CockroachDB is Café Copilot's working memory: migrates the
// schema, writes and reads back a conversation, embeds two tiny texts via real Bedrock,
// vector-searches them with a third embedded query, then cleans up its own rows. Prints
// PASS/FAIL per step (never the connection string). Run with:
//   npm run verify --workspace=memory  (or: node memory/verify.mjs)
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(REPO_ROOT, '.env.local') });

const VERIFY_BUSINESS_ID = 'verify-script-demo-cafe';
const VERIFY_PRINCIPAL = {
  businessId: VERIFY_BUSINESS_ID,
  actorId: 'legacy_demo',
  accessMode: 'legacy_demo',
};

function logStep(label, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function main() {
  let allPassed = true;
  const { runMigrations } = await import('./migrate.mjs');
  const { Pool } = pg;

  const connectionString = process.env.CRDB_CONNECTION_STRING;
  if (!connectionString) {
    console.error('CRDB_CONNECTION_STRING is not set in .env.local.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  const store = await import('./store.mjs');
  const { embedText } = await import('../agent/embeddings.mjs');

  let conversationId;
  let documentIds = [];

  try {
    // 1. Migrate (idempotent — safe to re-run against a live schema).
    try {
      await runMigrations({ client, embeddingDim: process.env.EMBEDDING_DIM });
      allPassed = logStep('migrate schema', true) && allPassed;
    } catch (err) {
      allPassed = logStep('migrate schema', false, err.message) && allPassed;
      throw err;
    }

    // 2. Conversation + messages round trip.
    try {
      conversationId = await store.createConversation(VERIFY_PRINCIPAL, { title: 'verify run' });
      await store.appendMessage(VERIFY_PRINCIPAL, { conversationId, role: 'user', content: 'What did I just ask you?' });
      await store.appendMessage(VERIFY_PRINCIPAL, {
        conversationId,
        role: 'assistant',
        content: "You haven't asked me anything yet in this conversation.",
      });
      const recent = await store.getRecentMessages(VERIFY_PRINCIPAL, conversationId, 12);
      const ok = recent.length === 2 && recent[0].role === 'user' && recent[1].role === 'assistant';
      allPassed = logStep('create conversation + append + read back 2 messages', ok, JSON.stringify(recent.map((m) => m.role))) && allPassed;
    } catch (err) {
      allPassed = logStep('conversation + messages round trip', false, err.message) && allPassed;
    }

    // 3. Embed two tiny texts via real Bedrock and upsert as documents.
    let coldBrewId;
    let croissantId;
    try {
      const coldBrewEmbedding = await embedText('cold brew sales');
      const croissantEmbedding = await embedText('croissant waste');
      coldBrewId = await store.upsertDocument(VERIFY_PRINCIPAL, {
        docType: 'verify-note',
        content: 'cold brew sales',
        embedding: coldBrewEmbedding,
      });
      croissantId = await store.upsertDocument(VERIFY_PRINCIPAL, {
        docType: 'verify-note',
        content: 'croissant waste',
        embedding: croissantEmbedding,
      });
      documentIds = [coldBrewId, croissantId];
      allPassed = logStep('embed 2 texts via Bedrock + upsert as documents', true, `dim=${coldBrewEmbedding.length}`) && allPassed;
    } catch (err) {
      allPassed = logStep('embed texts + upsert documents', false, err.message) && allPassed;
    }

    // 4. Vector search with a third embedded query — expect "cold brew sales" to rank first
    // for a "coffee drinks" query (both are coffee-related; croissant waste is not).
    try {
      const queryEmbedding = await embedText('coffee drinks');
      const results = await store.searchDocuments(VERIFY_PRINCIPAL, queryEmbedding, 5);
      const ranked = results.map((r) => `${r.content} (distance=${r.distance.toFixed(4)})`);
      const topResultIsColdBrew = results[0]?.content === 'cold brew sales';
      allPassed = logStep('vector search ranks "cold brew sales" above "croissant waste" for "coffee drinks"', topResultIsColdBrew, ranked.join('; ')) && allPassed;
    } catch (err) {
      allPassed = logStep('vector search', false, err.message) && allPassed;
    }
  } finally {
    // 5. Clean up this script's own rows regardless of pass/fail above.
    try {
      if (documentIds.length > 0) {
        await pool.query('DELETE FROM documents WHERE id = ANY($1)', [documentIds]);
      }
      if (conversationId) {
        await pool.query('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
        await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      }
      await pool.query('DELETE FROM documents WHERE business_id = $1', [VERIFY_BUSINESS_ID]);
      await pool.query('DELETE FROM conversations WHERE business_id = $1', [VERIFY_BUSINESS_ID]);
      logStep('clean up test rows', true);
    } catch (err) {
      allPassed = logStep('clean up test rows', false, err.message) && allPassed;
    }

    client.release();
    await store.closePool();
    await pool.end();
  }

  console.log(`\n${allPassed ? 'ALL STEPS PASSED' : 'SOME STEPS FAILED'}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('verify failed:', err?.message ?? err);
  process.exit(1);
});
