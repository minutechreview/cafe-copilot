import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { assertStagingUrl } from './pos-client.mjs';

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AuthContextError('The Copilot request took too long. Please try again.', 504);
  }
}

function abortAwareFetch(signal) {
  return (input, init = {}) => fetch(input, { ...init, signal: signal || init.signal });
}

/**
 * Error thrown during auth context resolution with distinct HTTP status codes (400, 401, 403, 500).
 */
export class AuthContextError extends Error {
  /**
   * @param {string} message - User-safe error message (never includes tokens or raw upstream exceptions)
   * @param {number} status - HTTP status code
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuthContextError';
    this.status = status;
  }
}

/**
 * Detects if an Authorization header is present in headers (regardless of casing or value).
 * @param {Object|Headers} headers
 * @returns {boolean}
 */
export function hasAuthorizationHeader(headers) {
  if (!headers) return false;
  if (typeof headers.has === 'function') {
    return headers.has('authorization') || headers.has('Authorization');
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

/**
 * Extracts Authorization header value case-insensitively.
 * @param {Object|Headers} headers
 * @returns {string|null}
 */
export function getAuthorizationHeader(headers) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get('authorization') || headers.get('Authorization') || null;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') {
      const val = headers[key];
      return typeof val === 'string' && val.trim() !== '' ? val : null;
    }
  }
  return null;
}

/**
 * Extracts Bearer token string from an Authorization header value.
 * @param {string} authHeader
 * @returns {string|null}
 */
export function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer' && parts[1]) {
    return parts[1];
  }
  return null;
}

/**
 * Checks whether a field exists in input or body object.
 * @param {Object} input
 * @param {Object} body
 * @param {string} fieldName
 * @returns {boolean}
 */
function hasField(input, body, fieldName) {
  if (input && Object.prototype.hasOwnProperty.call(input, fieldName)) {
    return true;
  }
  if (body && typeof body === 'object' && body !== null && Object.prototype.hasOwnProperty.call(body, fieldName)) {
    return true;
  }
  return false;
}

/**
 * Resolves the authenticated or demo principal context according to Step 1 contract.
 *
 * @param {Object} input - Request input
 * @param {Object} [input.headers] - HTTP headers object or Headers instance
 * @param {Object} [input.body] - Parsed request body containing mode, businessId, etc.
 * @param {string} [input.mode] - Direct mode override ('authenticated' | 'demo')
 * @param {string} [input.businessId] - Direct businessId override
 * @param {Object} [options] - Injectable options for unit testing
 * @param {Object} [options.supabaseClient] - Pre-configured mock Supabase client
 * @param {Function} [options.createSupabaseClient] - Factory for Supabase client
 * @returns {Promise<Object>} Minimal trusted principal
 */
export async function resolveAuthContext(input = {}, options = {}) {
  const headers = input.headers || {};
  const body = input.body || {};
  const signal = options.signal || input.signal;

  throwIfAborted(signal);

  const mode = input.mode || body.mode;
  const businessId = input.businessId !== undefined ? input.businessId : body.businessId;

  if (!mode || typeof mode !== 'string') {
    throw new AuthContextError('Missing or invalid mode. Mode must be explicitly "authenticated" or "demo".', 400);
  }

  const normalizedMode = mode.trim().toLowerCase();

  if (normalizedMode === 'demo') {
    if (hasAuthorizationHeader(headers)) {
      throw new AuthContextError('Demo mode requests must not include an Authorization header.', 400);
    }
    if (hasField(input, body, 'businessId')) {
      throw new AuthContextError('Demo mode requests must not include a businessId.', 400);
    }

    throwIfAborted(signal);
    const demoSessionId = `demo-session-${randomUUID()}`;

    return {
      mode: 'demo',
      demoSessionId,
      userId: null,
      businessId: null,
    };
  }

  if (normalizedMode === 'authenticated') {
    if (!businessId || typeof businessId !== 'string' || businessId.trim() === '') {
      throw new AuthContextError('businessId is required in authenticated mode.', 400);
    }

    if (!hasAuthorizationHeader(headers)) {
      throw new AuthContextError('Authorization header is required in authenticated mode.', 401);
    }

    const authHeader = getAuthorizationHeader(headers);
    const token = extractBearerToken(authHeader);
    if (!token) {
      throw new AuthContextError('Malformed Authorization header. Must be "Bearer <token>".', 400);
    }

    let supabase;
    try {
      throwIfAborted(signal);
      if (options.supabaseClient) {
        supabase = options.supabaseClient;
      } else if (options.createSupabaseClient) {
        assertStagingUrl(process.env.POS_SUPABASE_URL);
        supabase = options.createSupabaseClient(token);
      } else {
        const url = process.env.POS_SUPABASE_URL;
        const anonKey = process.env.POS_SUPABASE_ANON_KEY;
        if (!url || !anonKey) {
          throw new Error('POS Supabase configuration missing');
        }
        assertStagingUrl(url);
        supabase = createClient(url, anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            headers: { Authorization: `Bearer ${token}` },
            fetch: abortAwareFetch(signal),
          },
        });
      }
    } catch {
      if (signal?.aborted) throw new AuthContextError('The Copilot request took too long. Please try again.', 504);
      throw new AuthContextError('Failed to initialize authentication client.', 500);
    }

    let userResult;
    try {
      throwIfAborted(signal);
      userResult = await supabase.auth.getUser(token);
      throwIfAborted(signal);
    } catch {
      if (signal?.aborted) throw new AuthContextError('The Copilot request took too long. Please try again.', 504);
      throw new AuthContextError('Invalid or expired authentication token.', 401);
    }

    const { data: userData, error: userError } = userResult || {};
    if (userError || !userData?.user?.id) {
      throw new AuthContextError('Invalid or expired authentication token.', 401);
    }

    const userId = userData.user.id;

    let memberships;
    try {
      throwIfAborted(signal);
      let membershipQuery = supabase
        .from('business_memberships')
        .select('role, status')
        .eq('user_id', userId)
        .eq('business_id', businessId.trim())
        .in('role', ['owner', 'manager'])
        .eq('status', 'active');

      if (signal && typeof membershipQuery.abortSignal === 'function') {
        membershipQuery = membershipQuery.abortSignal(signal);
      }
      const queryResult = await membershipQuery;
      throwIfAborted(signal);

      if (queryResult.error) {
        throw queryResult.error;
      }
      memberships = queryResult.data;
    } catch {
      if (signal?.aborted) throw new AuthContextError('The Copilot request took too long. Please try again.', 504);
      throw new AuthContextError('Failed to query membership access.', 500);
    }

    if (!memberships || memberships.length === 0) {
      throw new AuthContextError('Access denied: active owner or manager membership required.', 403);
    }

    const activeOwnerOrManager = memberships.some((m) => {
      const isOwnerOrManager = m.role === 'owner' || m.role === 'manager';
      const isActive = m.status === 'active';
      return isOwnerOrManager && isActive;
    });

    if (!activeOwnerOrManager) {
      throw new AuthContextError('Access denied: active owner or manager membership required.', 403);
    }

    return {
      mode: 'authenticated',
      userId,
      businessId: businessId.trim(),
      accessToken: token,
    };
  }

  throw new AuthContextError('Missing or invalid mode. Mode must be explicitly "authenticated" or "demo".', 400);
}
