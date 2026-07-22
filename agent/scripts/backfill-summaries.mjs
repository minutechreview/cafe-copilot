#!/usr/bin/env node
// One-time (idempotent) backfill: for each date in the seeded demo café's history, fetches
// the POS daily summary, embeds a narrative + key-figures text, and upserts it into
// memory/documents (doc_type='daily_summary') so search_memory can retrieve it.
//
// Idempotent: memory/store.mjs's upsertDocument keys on (business_id, doc_type, doc_date)
// when no explicit id is given, so re-running this script updates existing rows instead of
// duplicating them.
//
// Read-only against POS staging (same auth approach as pos-sync/cli.mjs and
// agent/pos-client.mjs); real writes only ever go to CockroachDB memory.
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { generateDailySummary } from '../../pos-sync/summarizer.mjs';
import { embedText } from '../embeddings.mjs';
import { upsertDocument, closePool } from '../../memory/store.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: path.join(REPO_ROOT, '.env.local') });

const STAGING_PROJECT_REF = 'ljnzschozufepfpkzwjy';
const SEED_START = '2026-06-22';
const SEED_END = '2026-07-12';
const DAY_MS = 86_400_000;

function assertStagingUrl(url) {
  let ref = '';
  try {
    ref = new URL(url).hostname.split('.')[0];
  } catch {
    // ref stays '' — falls through to the mismatch error below with a clear reason.
  }
  if (ref !== STAGING_PROJECT_REF) {
    throw new Error(
      `SAFETY ABORT: staging ${STAGING_PROJECT_REF} required; received ${ref || 'invalid/missing URL'}.`
    );
  }
}

function* dateRange(startIso, endIso) {
  let cursor = new Date(`${startIso}T00:00:00Z`).valueOf();
  const end = new Date(`${endIso}T00:00:00Z`).valueOf();
  while (cursor <= end) {
    yield new Date(cursor).toISOString().slice(0, 10);
    cursor += DAY_MS;
  }
}

function buildDocumentContent(summary) {
  const k = summary.kpis;
  const c = summary.cash;
  const e = summary.exceptions;
  const stats = [
    `Gross ${summary.currency} ${k.gross_sales}, ${k.order_count} orders, avg ${summary.currency} ${k.avg_transaction_value}.`,
    `Cash: opening ${summary.currency} ${c.opening_float_total}, expected ${summary.currency} ${c.expected_total}, counted ${summary.currency} ${c.counted_total}, over/short ${summary.currency} ${c.over_short_total}, banked ${summary.currency} ${c.banked_total}.`,
    `Refunds ${e.refunds.count} (${summary.currency} ${e.refunds.value}), voids ${e.voids.count} (${summary.currency} ${e.voids.value}), paid in ${e.paid_in.count}, paid out ${e.paid_out.count}, no-sales ${e.no_sale_count}.`,
  ].join(' ');
  return `${summary.narrative}\n${stats}`;
}

async function authenticate() {
  const url = process.env.POS_SUPABASE_URL;
  const anonKey = process.env.POS_SUPABASE_ANON_KEY;
  assertStagingUrl(url);
  if (!anonKey) throw new Error('POS_SUPABASE_ANON_KEY is not configured');

  const email = process.env.DEMO_OWNER_EMAIL || 'cafe-copilot-demo@example.com';
  const password = process.env.DEMO_OWNER_PASSWORD || 'CafeCopilot-Demo-2026!';
  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`POS staging authentication failed: ${error.message}`);
  return supabase;
}

async function main() {
  const businessId = process.env.DEMO_BUSINESS_ID;
  if (!businessId) throw new Error('DEMO_BUSINESS_ID is not configured');

  const supabase = await authenticate();

  let embedded = 0;
  let skipped = 0;
  const principal = {
    businessId,
    actorId: 'legacy_demo',
    accessMode: 'legacy_demo',
  };

  for (const date of dateRange(SEED_START, SEED_END)) {
    const summary = await generateDailySummary({ supabase, businessId, date });
    if (!summary) {
      skipped += 1;
      console.log(`skip ${date}: no activity`);
      continue;
    }
    const content = buildDocumentContent(summary);
    const embedding = await embedText(content);
    await upsertDocument(principal, {
      docType: 'daily_summary',
      docDate: date,
      content,
      metadata: summary,
      embedding,
    });
    embedded += 1;
    console.log(`embedded ${date}`);
  }

  console.log(`Backfill complete: ${embedded} embedded, ${skipped} skipped (no activity).`);
}

main()
  .catch((err) => {
    console.error('backfill failed:', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
