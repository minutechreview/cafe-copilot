import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const signInWithPasswordMock = vi.fn();
const createClientMock = vi.fn().mockImplementation((url, key, options) => ({
  url,
  key,
  options,
  auth: { signInWithPassword: signInWithPasswordMock },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

describe('agent/pos-client.mjs', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
    signInWithPasswordMock.mockReset();
    process.env.POS_SUPABASE_URL = 'https://ljnzschozufepfpkzwjy.supabase.co';
    process.env.POS_SUPABASE_ANON_KEY = 'anon-key';
    process.env.DEMO_OWNER_EMAIL = 'demo@cafe.com';
    process.env.DEMO_OWNER_PASSWORD = 'SecretDemoPassword123!';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('getDemoPosClient', () => {
    it('signs in with environment demo owner credentials and returns the cached client', async () => {
      signInWithPasswordMock.mockResolvedValueOnce({ error: null });
      const { getDemoPosClient } = await import('../pos-client.mjs');

      const supabase = await getDemoPosClient();

      expect(createClientMock).toHaveBeenCalledWith(
        'https://ljnzschozufepfpkzwjy.supabase.co',
        'anon-key',
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      expect(signInWithPasswordMock).toHaveBeenCalledWith({
        email: 'demo@cafe.com',
        password: 'SecretDemoPassword123!',
      });
      expect(supabase).toBeDefined();
    });

    it('caches the demo client across calls (single sign-in)', async () => {
      signInWithPasswordMock.mockResolvedValue({ error: null });
      const { getDemoPosClient } = await import('../pos-client.mjs');

      const client1 = await getDemoPosClient();
      const client2 = await getDemoPosClient();

      expect(createClientMock).toHaveBeenCalledTimes(1);
      expect(signInWithPasswordMock).toHaveBeenCalledTimes(1);
      expect(client1).toBe(client2);
    });

    it('fails safely when DEMO_OWNER_EMAIL or DEMO_OWNER_PASSWORD is missing without revealing values', async () => {
      delete process.env.DEMO_OWNER_EMAIL;
      const { getDemoPosClient } = await import('../pos-client.mjs');

      await expect(getDemoPosClient()).rejects.toThrow('Demo credentials missing');
      expect(signInWithPasswordMock).not.toHaveBeenCalled();
    });

    it('refuses a non-staging URL before creating a client', async () => {
      process.env.POS_SUPABASE_URL = 'https://iveygqneqlsxvdvdxxgx.supabase.co';
      const { getDemoPosClient } = await import('../pos-client.mjs');

      await expect(getDemoPosClient()).rejects.toThrow(/SAFETY ABORT/);
      expect(createClientMock).not.toHaveBeenCalled();
    });

    it('wraps a failed sign-in in a plain error and does not cache the failure', async () => {
      signInWithPasswordMock
        .mockResolvedValueOnce({ error: { message: 'invalid credentials' } })
        .mockResolvedValueOnce({ error: null });
      const { getDemoPosClient } = await import('../pos-client.mjs');

      await expect(getDemoPosClient()).rejects.toThrow('POS staging authentication failed: invalid credentials');

      await expect(getDemoPosClient()).resolves.toBeDefined();
      expect(signInWithPasswordMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAuthenticatedPosClient', () => {
    it('creates fresh isolated clients for different caller tokens', async () => {
      const { getAuthenticatedPosClient } = await import('../pos-client.mjs');

      const client1 = getAuthenticatedPosClient('user-token-aaa');
      const client2 = getAuthenticatedPosClient('user-token-bbb');

      expect(client1).not.toBe(client2);
      expect(createClientMock).toHaveBeenCalledWith(
        'https://ljnzschozufepfpkzwjy.supabase.co',
        'anon-key',
        {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: 'Bearer user-token-aaa' } },
        }
      );
      expect(createClientMock).toHaveBeenCalledWith(
        'https://ljnzschozufepfpkzwjy.supabase.co',
        'anon-key',
        {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: 'Bearer user-token-bbb' } },
        }
      );
    });

    it('never calls demo sign-in when creating an authenticated client', async () => {
      const { getAuthenticatedPosClient } = await import('../pos-client.mjs');

      getAuthenticatedPosClient('jwt-token-123');

      expect(signInWithPasswordMock).not.toHaveBeenCalled();
    });

    it('throws error when accessToken is missing or empty', async () => {
      const { getAuthenticatedPosClient } = await import('../pos-client.mjs');

      expect(() => getAuthenticatedPosClient('')).toThrow('accessToken is required for authenticated POS client');
      expect(() => getAuthenticatedPosClient(null)).toThrow('accessToken is required for authenticated POS client');
    });

    it('refuses non-staging URL for authenticated client', async () => {
      process.env.POS_SUPABASE_URL = 'https://iveygqneqlsxvdvdxxgx.supabase.co';
      const { getAuthenticatedPosClient } = await import('../pos-client.mjs');

      expect(() => getAuthenticatedPosClient('jwt-token')).toThrow(/SAFETY ABORT/);
    });
  });
});
