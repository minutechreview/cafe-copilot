import { createClient } from '@supabase/supabase-js';

const STAGING_PROJECT_REF = 'ljnzschozufepfpkzwjy';

let demoClientPromise;

/**
 * Validates that the Supabase URL points strictly to the allowed POS staging project.
 * @param {string} url
 */
export function assertStagingUrl(url) {
  let ref = '';
  try {
    ref = new URL(url).hostname.split('.')[0];
  } catch {
    // ref stays '' — falls through to error below
  }
  if (ref !== STAGING_PROJECT_REF) {
    throw new Error(
      `SAFETY ABORT: staging ${STAGING_PROJECT_REF} required; received ${ref || 'invalid/missing URL'}.`
    );
  }
}

/**
 * Signs in with environment demo credentials to get a cached demo POS client.
 */
async function authenticateDemo() {
  const url = process.env.POS_SUPABASE_URL;
  const anonKey = process.env.POS_SUPABASE_ANON_KEY;
  assertStagingUrl(url);
  if (!anonKey) {
    throw new Error('POS_SUPABASE_ANON_KEY is not configured');
  }

  const email = process.env.DEMO_OWNER_EMAIL;
  const password = process.env.DEMO_OWNER_PASSWORD;

  if (!email || !password) {
    throw new Error('Demo credentials missing (DEMO_OWNER_EMAIL / DEMO_OWNER_PASSWORD environment variables required)');
  }

  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`POS staging authentication failed: ${error.message}`);
  }
  return supabase;
}

/**
 * Returns a cached, authenticated Supabase client for explicit DEMO mode only.
 * Reused across warm invocations.
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export function getDemoPosClient() {
  if (!demoClientPromise) {
    demoClientPromise = authenticateDemo().catch((err) => {
      demoClientPromise = undefined;
      throw err;
    });
  }
  return demoClientPromise;
}

/**
 * Returns a fresh request-scoped Supabase client initialized with the caller's verified JWT.
 * NEVER globally cached; never signs in with demo credentials.
 * @param {string} accessToken - Verified caller Supabase JWT token
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function getAuthenticatedPosClient(accessToken) {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw new Error('accessToken is required for authenticated POS client');
  }

  const url = process.env.POS_SUPABASE_URL;
  const anonKey = process.env.POS_SUPABASE_ANON_KEY;
  assertStagingUrl(url);
  if (!anonKey) {
    throw new Error('POS_SUPABASE_ANON_KEY is not configured');
  }

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken.trim()}` } },
  });
}

/** Legacy alias for getDemoPosClient to preserve existing demo compatibility. */
export function getPosClient() {
  return getDemoPosClient();
}

/** Test-only: clears the cached demo client promise. */
export function resetPosClientForTests() {
  demoClientPromise = undefined;
}
