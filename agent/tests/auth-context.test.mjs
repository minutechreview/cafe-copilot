import { describe, it, expect, vi } from 'vitest';
import {
  resolveAuthContext,
  AuthContextError,
  hasAuthorizationHeader,
  getAuthorizationHeader,
  extractBearerToken,
} from '../auth-context.mjs';

function createMockSupabaseClient({
  user = null,
  userError = null,
  memberships = [],
  membershipError = null,
  throwOnQuery = false,
} = {}) {
  const queryState = { userId: null, businessId: null, roles: null, status: null };

  const client = {
    auth: {
      getUser: vi.fn().mockImplementation(() => {
        if (userError) {
          return Promise.resolve({ data: { user: null }, error: userError });
        }
        return Promise.resolve({ data: { user }, error: null });
      }),
    },
    from: vi.fn().mockImplementation((table) => {
      if (table === 'business_memberships') {
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation((col, val) => {
            if (col === 'user_id') queryState.userId = val;
            if (col === 'business_id') queryState.businessId = val;
            if (col === 'status') queryState.status = val;
            return chain;
          }),
          in: vi.fn().mockImplementation((col, vals) => {
            if (col === 'role') queryState.roles = vals;
            return chain;
          }),
          then: (resolve, reject) => {
            if (throwOnQuery) {
              if (reject) {
                reject(throwOnQuery);
              } else {
                throw throwOnQuery;
              }
              return;
            }
            if (membershipError) {
              resolve({ data: null, error: membershipError });
            } else {
              let filtered = memberships;
              if (queryState.roles && Array.isArray(queryState.roles)) {
                filtered = filtered.filter((m) => queryState.roles.includes(m.role));
              }
              if (queryState.status !== null) {
                filtered = filtered.filter((m) => m.status === queryState.status);
              }
              resolve({ data: filtered, error: null });
            }
          },
        };
        return chain;
      }
      return {};
    }),
    __queryState: queryState,
  };

  return client;
}

describe('auth-context helper utilities', () => {
  it('detects authorization header presence case-insensitively', () => {
    expect(hasAuthorizationHeader({ authorization: '' })).toBe(true);
    expect(hasAuthorizationHeader({ Authorization: null })).toBe(true);
    expect(hasAuthorizationHeader({ AUTHORIZATION: 'Bearer token' })).toBe(true);
    expect(hasAuthorizationHeader({})).toBe(false);
    expect(hasAuthorizationHeader(null)).toBe(false);

    const headersObj = new Headers();
    headersObj.set('Authorization', '');
    expect(hasAuthorizationHeader(headersObj)).toBe(true);
  });

  it('parses Authorization headers case-insensitively', () => {
    expect(getAuthorizationHeader({ authorization: 'Bearer tok-1' })).toBe('Bearer tok-1');
    expect(getAuthorizationHeader({ Authorization: 'Bearer tok-2' })).toBe('Bearer tok-2');
    expect(getAuthorizationHeader({ AUTHORIZATION: 'Bearer tok-3' })).toBe('Bearer tok-3');
    expect(getAuthorizationHeader({})).toBeNull();
    expect(getAuthorizationHeader(null)).toBeNull();

    const headersObj = new Headers();
    headersObj.set('Authorization', 'Bearer tok-4');
    expect(getAuthorizationHeader(headersObj)).toBe('Bearer tok-4');
  });

  it('extracts Bearer tokens accurately', () => {
    expect(extractBearerToken('Bearer secret-token-123')).toBe('secret-token-123');
    expect(extractBearerToken('bearer lower-token')).toBe('lower-token');
    expect(extractBearerToken('BEARER upper-token')).toBe('upper-token');
    expect(extractBearerToken('Basic secret')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer   ')).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });
});

describe('resolveAuthContext - authenticated mode', () => {
  const validUser = { id: 'user-uuid-123', email: 'owner@cafe.com' };
  const validBusinessId = 'biz-uuid-456';
  const secretToken = 'secret-jwt-token-999';

  it('resolves a valid owner principal and asserts query filters', async () => {
    const supabaseClient = createMockSupabaseClient({
      user: validUser,
      memberships: [{ role: 'owner', status: 'active' }],
    });

    const principal = await resolveAuthContext(
      {
        headers: { authorization: `Bearer ${secretToken}` },
        mode: 'authenticated',
        businessId: validBusinessId,
      },
      { supabaseClient }
    );

    expect(principal).toEqual({
      mode: 'authenticated',
      userId: 'user-uuid-123',
      businessId: 'biz-uuid-456',
      accessToken: secretToken,
    });
    expect(supabaseClient.auth.getUser).toHaveBeenCalledWith(secretToken);
    expect(supabaseClient.__queryState).toEqual({
      userId: 'user-uuid-123',
      businessId: 'biz-uuid-456',
      roles: ['owner', 'manager'],
      status: 'active',
    });
  });

  it('resolves a valid manager principal successfully with lowercase header', async () => {
    const supabaseClient = createMockSupabaseClient({
      user: validUser,
      memberships: [{ role: 'manager', status: 'active' }],
    });

    const principal = await resolveAuthContext(
      {
        headers: { authorization: `Bearer ${secretToken}` },
        body: { mode: 'authenticated', businessId: validBusinessId },
      },
      { supabaseClient }
    );

    expect(principal.mode).toBe('authenticated');
    expect(principal.userId).toBe('user-uuid-123');
    expect(principal.businessId).toBe('biz-uuid-456');
    expect(principal.accessToken).toBe(secretToken);
  });

  it('denies cross-tenant requests when user belongs to biz-1 but requests biz-2', async () => {
    const supabaseClient = createMockSupabaseClient({
      user: validUser,
      memberships: [], // Query for requested business_id 'biz-2' returns no rows
    });

    await expect(
      resolveAuthContext(
        {
          headers: { authorization: `Bearer ${secretToken}` },
          mode: 'authenticated',
          businessId: 'biz-2',
        },
        { supabaseClient }
      )
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Access denied/i),
    });

    expect(supabaseClient.__queryState.businessId).toBe('biz-2');
    expect(supabaseClient.__queryState.userId).toBe('user-uuid-123');
  });

  it('throws 400 Bad Request if businessId is missing or whitespace', async () => {
    await expect(
      resolveAuthContext({
        headers: { authorization: `Bearer ${secretToken}` },
        mode: 'authenticated',
        businessId: '',
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/businessId is required/i),
    });
  });

  it('throws 401 Unauthorized if Authorization header is missing', async () => {
    await expect(
      resolveAuthContext({
        headers: {},
        mode: 'authenticated',
        businessId: validBusinessId,
      })
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/Authorization header is required/i),
    });
  });

  it('throws 400 Bad Request if Authorization header value is malformed', async () => {
    await expect(
      resolveAuthContext({
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
        mode: 'authenticated',
        businessId: validBusinessId,
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Malformed Authorization header/i),
    });

    await expect(
      resolveAuthContext({
        headers: { authorization: 'Bearer' },
        mode: 'authenticated',
        businessId: validBusinessId,
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Malformed Authorization header/i),
    });
  });

  it('throws 401 Unauthorized if JWT token is invalid or expired', async () => {
    const supabaseClient = createMockSupabaseClient({
      userError: { message: 'jwt expired' },
    });

    await expect(
      resolveAuthContext(
        {
          headers: { authorization: `Bearer ${secretToken}` },
          mode: 'authenticated',
          businessId: validBusinessId,
        },
        { supabaseClient }
      )
    ).rejects.toMatchObject({
      status: 401,
      message: 'Invalid or expired authentication token.',
    });
  });

  it('throws 403 Forbidden if user has no membership in requested business', async () => {
    const supabaseClient = createMockSupabaseClient({
      user: validUser,
      memberships: [],
    });

    await expect(
      resolveAuthContext(
        {
          headers: { authorization: `Bearer ${secretToken}` },
          mode: 'authenticated',
          businessId: validBusinessId,
        },
        { supabaseClient }
      )
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Access denied/i),
    });
  });

  it('throws 403 Forbidden if membership role is staff', async () => {
    const supabaseClient = createMockSupabaseClient({
      user: validUser,
      memberships: [{ role: 'staff', status: 'active' }],
    });

    await expect(
      resolveAuthContext(
        {
          headers: { authorization: `Bearer ${secretToken}` },
          mode: 'authenticated',
          businessId: validBusinessId,
        },
        { supabaseClient }
      )
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Access denied/i),
    });
  });

  it('throws 403 Forbidden if membership status is null, missing, empty, inactive, or suspended', async () => {
    const statusesToDeny = [null, undefined, '', 'inactive', 'suspended', 'pending'];

    for (const statusVal of statusesToDeny) {
      const supabaseClient = createMockSupabaseClient({
        user: validUser,
        memberships: [{ role: 'owner', status: statusVal }],
      });

      await expect(
        resolveAuthContext(
          {
            headers: { authorization: `Bearer ${secretToken}` },
            mode: 'authenticated',
            businessId: validBusinessId,
          },
          { supabaseClient }
        )
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringMatching(/Access denied/i),
      });
    }
  });

  it('returns generic token-free 500 error when client creation/factory throws an exception', async () => {
    const sensitiveToken = 'SENSITIVE_FACTORY_CANARY_TOKEN_777';
    const createSupabaseClient = () => {
      throw new Error(`Factory failed with token ${sensitiveToken}`);
    };

    try {
      await resolveAuthContext(
        {
          headers: { authorization: `Bearer ${sensitiveToken}` },
          mode: 'authenticated',
          businessId: validBusinessId,
        },
        { createSupabaseClient }
      );
      expect.fail('Should have thrown AuthContextError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthContextError);
      expect(err.status).toBe(500);
      expect(err.message).toBe('Failed to initialize authentication client.');
      expect(err.message).not.toContain(sensitiveToken);
      expect(Object.values(err)).not.toContain(sensitiveToken);
      expect(JSON.stringify(err)).not.toContain(sensitiveToken);
    }
  });

  it('returns generic token-free 500 error when membership query throws an exception', async () => {
    const sensitiveToken = 'SENSITIVE_QUERY_CANARY_TOKEN_888';
    const supabaseClient = createMockSupabaseClient({
      user: validUser,
      throwOnQuery: new Error(`Database connection failed with token ${sensitiveToken}`),
    });

    try {
      await resolveAuthContext(
        {
          headers: { authorization: `Bearer ${sensitiveToken}` },
          mode: 'authenticated',
          businessId: validBusinessId,
        },
        { supabaseClient }
      );
      expect.fail('Should have thrown AuthContextError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthContextError);
      expect(err.status).toBe(500);
      expect(err.message).toBe('Failed to query membership access.');
      expect(err.message).not.toContain(sensitiveToken);
      expect(Object.values(err)).not.toContain(sensitiveToken);
      expect(JSON.stringify(err)).not.toContain(sensitiveToken);
    }
  });
});

describe('resolveAuthContext - demo mode', () => {
  it('resolves explicit mode: "demo" with high-entropy server-side demoSessionId', async () => {
    const principal = await resolveAuthContext({
      mode: 'demo',
    });

    expect(principal.mode).toBe('demo');
    expect(principal.userId).toBeNull();
    expect(principal.businessId).toBeNull();
    expect(typeof principal.demoSessionId).toBe('string');
    expect(principal.demoSessionId).toMatch(/^demo-session-/);
  });

  it('ignores caller-supplied demoSessionId and conversationId', async () => {
    const principal = await resolveAuthContext({
      mode: 'demo',
      demoSessionId: 'caller-supplied-session-123',
      conversationId: 'caller-supplied-conv-456',
    });

    expect(principal.demoSessionId).not.toBe('caller-supplied-session-123');
    expect(principal.demoSessionId).not.toBe('caller-supplied-conv-456');
    expect(principal.demoSessionId).toMatch(/^demo-session-/);
  });

  it('generates distinct actor IDs for separate demo resolutions', async () => {
    const principal1 = await resolveAuthContext({ mode: 'demo' });
    const principal2 = await resolveAuthContext({ mode: 'demo' });

    expect(principal1.demoSessionId).not.toBe(principal2.demoSessionId);
  });

  it('rejects demo mode request when Authorization header field is present (even if empty or null)', async () => {
    await expect(
      resolveAuthContext({
        mode: 'demo',
        headers: { authorization: '' },
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Demo mode requests must not include an Authorization header/i),
    });

    await expect(
      resolveAuthContext({
        mode: 'demo',
        headers: { Authorization: null },
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Demo mode requests must not include an Authorization header/i),
    });
  });

  it('rejects demo mode request when businessId field is present (including null, empty, or whitespace)', async () => {
    await expect(
      resolveAuthContext({
        mode: 'demo',
        businessId: null,
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Demo mode requests must not include a businessId/i),
    });

    await expect(
      resolveAuthContext({
        mode: 'demo',
        businessId: '',
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Demo mode requests must not include a businessId/i),
    });
  });
});

describe('resolveAuthContext - invalid mode & security invariants', () => {
  it('throws 400 Bad Request when mode is missing', async () => {
    await expect(resolveAuthContext({})).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Missing or invalid mode/i),
    });
  });

  it('throws 400 Bad Request when mode is unrecognized', async () => {
    await expect(resolveAuthContext({ mode: 'admin' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Missing or invalid mode/i),
    });
  });

  it('throws 400 Bad Request for missing/unknown mode even when Authorization header is present and never enters demo mode', async () => {
    await expect(
      resolveAuthContext({
        headers: { authorization: 'Bearer some-secret-token' },
        mode: 'unknown',
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Missing or invalid mode/i),
    });
  });

  it('never leaks bearer token in error object properties or message', async () => {
    const sensitiveToken = 'SUPER_SECRET_TOKEN_DO_NOT_LEAK_12345';
    const supabaseClient = createMockSupabaseClient({
      userError: { message: `Failed for ${sensitiveToken}` },
    });

    try {
      await resolveAuthContext(
        {
          headers: { authorization: `Bearer ${sensitiveToken}` },
          mode: 'authenticated',
          businessId: 'biz-123',
        },
        { supabaseClient }
      );
      expect.fail('Should have thrown AuthContextError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthContextError);
      expect(err.message).not.toContain(sensitiveToken);
      expect(JSON.stringify(err)).not.toContain(sensitiveToken);
    }
  });
});
