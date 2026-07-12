// Cached, authenticated Supabase client for the POS staging project — used by the
// get_day_summary tool to call pos-sync's generateDailySummary with live data.
//
// pos-sync/ is owned by the Codex track and this file never edits it; it replicates the
// same auth approach pos-sync/cli.mjs already uses (same demo-owner credentials, same
// staging-project safety check) because that pattern is already proven live against the
// seeded demo café.
//
// The client is cached as a module-level promise so a warm Lambda invocation (or the
// long-lived dev server process) reuses the same authenticated session instead of signing
// in again on every tool call. A failed auth attempt is not cached, so the next call
// retries cleanly rather than being stuck replaying the same failure.
import { createClient } from '@supabase/supabase-js';

const STAGING_PROJECT_REF = 'ljnzschozufepfpkzwjy';

let clientPromise;

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

async function authenticate() {
  const url = process.env.POS_SUPABASE_URL;
  const anonKey = process.env.POS_SUPABASE_ANON_KEY;
  assertStagingUrl(url);
  if (!anonKey) {
    throw new Error('POS_SUPABASE_ANON_KEY is not configured');
  }

  // Same fallback credentials pos-sync/cli.mjs and demo-seed/seed.mjs already use — this is
  // the demo owner account those scripts created and verified live, not a guess.
  const email = process.env.DEMO_OWNER_EMAIL || 'cafe-copilot-demo@example.com';
  const password = process.env.DEMO_OWNER_PASSWORD || 'CafeCopilot-Demo-2026!';

  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`POS staging authentication failed: ${error.message}`);
  }
  return supabase;
}

/**
 * Returns a cached, authenticated Supabase client for POS staging (SELECT-only usage — the
 * copilot never writes to the POS). Reused across warm invocations.
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export function getPosClient() {
  if (!clientPromise) {
    clientPromise = authenticate().catch((err) => {
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

/** Test-only: clears the cached client/promise so tests can force re-authentication. */
export function resetPosClientForTests() {
  clientPromise = undefined;
}
