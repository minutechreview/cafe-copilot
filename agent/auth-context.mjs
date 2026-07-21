import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

/**
 * Error thrown during auth context resolution with distinct HTTP status codes (400, 401, 403, 500).
 */
export class AuthContextError extends Error {
  /**
   * @param {string} message - User-safe error message (never includes tokens)
   * @param {number} status - HTTP status code
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuthContextError';
    this.status = status;
  }
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
 * Resolves the authenticated or demo principal context according to Step 1 contract.
 *
 * @param {Object} input - Request input
 * @param {Object} [input.headers] - HTTP headers object or Headers instance
 * @param {Object} [input.body] - Parsed request body containing mode, businessId, etc.
 * @param {string} [input.mode] - Direct mode override ('authenticated' | 'demo')
 * @param {string} [input.businessId] - Direct businessId override
 * @param {string} [input.demoSessionId] - Optional client-supplied demo session ID
 * @param {Object} [options] - Injectable options for unit testing
 * @param {Object} [options.supabaseClient] - Pre-configured mock Supabase client
 * @param {Function} [options.createSupabaseClient] - Factory for Supabase client
 * @returns {Promise<Object>} Minimal trusted principal
 */
export async function resolveAuthContext(input = {}, options = {}) {
  const headers = input.headers || {};
  const body = input.body || {};

  const mode = input.mode || body.mode;
  const businessId = input.businessId !== undefined ? input.businessId : body.businessId;
  const authHeader = getAuthorizationHeader(headers);

  if (!mode || typeof mode !== 'string') {
    throw new AuthContextError('Missing or invalid mode. Mode must be explicitly "authenticated" or "demo".', 400);
  }

  const normalizedMode = mode.trim().toLowerCase();

  if (normalizedMode === 'demo') {
    if (authHeader !== null) {
      throw new AuthContextError('Demo mode requests must not include an Authorization header.', 400);
    }
    if (businessId !== undefined && businessId !== null && businessId !== '') {
      throw new AuthContextError('Demo mode requests must not include a businessId.', 400);
    }

    const demoSessionId =
      input.demoSessionId ||
      body.demoSessionId ||
      input.conversationId ||
      body.conversationId ||
      `demo-session-${randomUUID()}`;

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

    if (!authHeader) {
      throw new AuthContextError('Authorization header is required in authenticated mode.', 401);
    }

    const token = extractBearerToken(authHeader);
    if (!token) {
      throw new AuthContextError('Malformed Authorization header. Must be "Bearer <token>".', 400);
    }

    let supabase;
    if (options.supabaseClient) {
      supabase = options.supabaseClient;
    } else if (options.createSupabaseClient) {
      supabase = options.createSupabaseClient(token);
    } else {
      const url = process.env.POS_SUPABASE_URL;
      const anonKey = process.env.POS_SUPABASE_ANON_KEY;
      if (!url || !anonKey) {
        throw new AuthContextError('POS Supabase configuration missing (POS_SUPABASE_URL / POS_SUPABASE_ANON_KEY).', 500);
      }
      supabase = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
    }

    let userResult;
    try {
      userResult = await supabase.auth.getUser(token);
    } catch {
      throw new AuthContextError('Invalid or expired authentication token.', 401);
    }

    const { data: userData, error: userError } = userResult || {};
    if (userError || !userData?.user?.id) {
      throw new AuthContextError('Invalid or expired authentication token.', 401);
    }

    const userId = userData.user.id;

    const { data: memberships, error: membershipError } = await supabase
      .from('business_memberships')
      .select('role, status')
      .eq('user_id', userId)
      .eq('business_id', businessId.trim());

    if (membershipError || !memberships || memberships.length === 0) {
      throw new AuthContextError('Access denied: no membership found for requested business.', 403);
    }

    const activeOwnerOrManager = memberships.some((m) => {
      const isOwnerOrManager = m.role === 'owner' || m.role === 'manager';
      const isActive = !m.status || m.status === 'active';
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
