import { createClient } from '@supabase/supabase-js';

const STAGING_PROJECT_REF = 'ljnzschozufepfpkzwjy';
const STAGING_HOSTNAME = `${STAGING_PROJECT_REF}.supabase.co`;

let demoClient;

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('Request deadline exceeded');
}

function abortAwareFetch(signal) {
  return (input, init = {}) => fetch(input, { ...init, signal: signal || init.signal });
}

function operationAwareFetch(input, init = {}) {
  return fetch(input, init);
}

/**
 * Validates that the Supabase URL points strictly to the allowed POS staging project.
 * Enforces HTTPS, exact hostname, no user credentials, and default port (443).
 * @param {string} url
 */
export function assertStagingUrl(url) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new Error(`SAFETY ABORT: staging ${STAGING_HOSTNAME} required; received invalid/missing URL.`);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SAFETY ABORT: staging ${STAGING_HOSTNAME} required; received invalid/missing URL.`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`SAFETY ABORT: staging ${STAGING_HOSTNAME} required; received non-HTTPS protocol.`);
  }

  if (parsed.hostname !== STAGING_HOSTNAME) {
    throw new Error(`SAFETY ABORT: staging ${STAGING_HOSTNAME} required; received ${parsed.hostname || 'invalid/missing URL'}.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`SAFETY ABORT: staging URL must not contain user credentials.`);
  }

  if (parsed.port && parsed.port !== '443') {
    throw new Error(`SAFETY ABORT: staging URL must not specify a custom port.`);
  }
}

/**
 * Signs in with environment demo credentials to get a cached demo POS client.
 */
async function authenticateDemo(signal) {
  throwIfAborted(signal);
  const url = process.env.POS_SUPABASE_URL;
  const anonKey = process.env.POS_SUPABASE_ANON_KEY;
  assertStagingUrl(url);

  if (!anonKey || typeof anonKey !== 'string' || !anonKey.trim()) {
    throw new Error('POS_SUPABASE_ANON_KEY is not configured');
  }

  const email = process.env.DEMO_OWNER_EMAIL;
  const password = process.env.DEMO_OWNER_PASSWORD;

  if (!email || typeof email !== 'string' || !email.trim() || !password || typeof password !== 'string' || !password.trim()) {
    throw new Error('Demo credentials missing (DEMO_OWNER_EMAIL / DEMO_OWNER_PASSWORD environment variables required)');
  }

  let supabase;
  try {
    supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: abortAwareFetch(signal) },
    });
  } catch {
    throw new Error('POS staging client creation failed');
  }

  let result;
  try {
    result = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    throwIfAborted(signal);
  } catch {
    throw new Error('POS staging authentication failed');
  }

  const { data, error } = result || {};
  if (error) {
    throw new Error('POS staging authentication failed');
  }
  const accessToken = data?.session?.access_token;
  if (!accessToken) throw new Error('POS staging authentication failed');

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: operationAwareFetch,
    },
  });
}

/**
 * Returns a cached, authenticated Supabase client for explicit DEMO mode only.
 * Reused across warm invocations.
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export async function getDemoPosClient({ signal } = {}) {
  throwIfAborted(signal);
  if (!demoClient) {
    const authenticatedClient = await authenticateDemo(signal);
    throwIfAborted(signal);
    demoClient ||= authenticatedClient;
  }
  throwIfAborted(signal);
  return demoClient;
}

/**
 * Returns a fresh request-scoped Supabase client initialized with the caller's verified JWT.
 * NEVER globally cached; never signs in with demo credentials.
 * @param {string} accessToken - Verified caller Supabase JWT token
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function getAuthenticatedPosClient(accessToken, { signal } = {}) {
  throwIfAborted(signal);
  if (!accessToken || typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('accessToken is required for authenticated POS client');
  }

  const url = process.env.POS_SUPABASE_URL;
  const anonKey = process.env.POS_SUPABASE_ANON_KEY;
  assertStagingUrl(url);

  if (!anonKey || typeof anonKey !== 'string' || !anonKey.trim()) {
    throw new Error('POS_SUPABASE_ANON_KEY is not configured');
  }

  try {
    return createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
        fetch: abortAwareFetch(signal),
      },
    });
  } catch {
    throw new Error('Failed to initialize authenticated POS client');
  }
}

/** Test-only: clears the cached demo client promise. */
export function resetPosClientForTests() {
  demoClient = undefined;
}
