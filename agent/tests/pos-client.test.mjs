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

  it('does not export legacy getPosClient alias', async () => {
    const mod = await import('../pos-client.mjs');
    expect(mod.getPosClient).toBeUndefined();
  });

  describe('assertStagingUrl hardening', () => {
    it('accepts exact staging HTTPS URL', async () => {
      const { assertStagingUrl } = await import('../pos-client.mjs');
      expect(() => assertStagingUrl('https://ljnzschozufepfpkzwjy.supabase.co')).not.toThrow();
      expect(() => assertStagingUrl('https://ljnzschozufepfpkzwjy.supabase.co:443')).not.toThrow();
    });

    it('rejects non-HTTPS, lookalike hosts, userinfo, and non-443 ports', async () => {
      const { assertStagingUrl } = await import('../pos-client.mjs');
      const invalidUrls = [
        'http://ljnzschozufepfpkzwjy.supabase.co',
        'https://ljnzschozufepfpkzwjy.supabase.co:8443',
        'https://ljnzschozufepfpkzwjy.supabase.co.attacker.com',
        'https://ljnzschozufepfpkzwjy-fake.supabase.co',
        'https://user:pass@ljnzschozufepfpkzwjy.supabase.co',
        'ftp://ljnzschozufepfpkzwjy.supabase.co',
        '',
        '   ',
        null,
        undefined,
      ];

      for (const invalidUrl of invalidUrls) {
        expect(() => assertStagingUrl(invalidUrl)).toThrow(/SAFETY ABORT/);
      }
    });
  });

  describe('getDemoPosClient', () => {
    it('signs in with environment demo owner credentials and returns the cached client', async () => {
      signInWithPasswordMock.mockResolvedValueOnce({ error: null });
      const { getDemoPosClient } = await import('../pos-client.mjs');

      const supabase = await getDemoPosClient();

      expect(createClientMock).toHaveBeenCalledWith(
        'https://ljnzschozufepfpkzwjy.supabase.co',
        'anon-key',
        {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { fetch: expect.any(Function) },
        }
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

    it('fails safely when DEMO_OWNER_EMAIL or DEMO_OWNER_PASSWORD is missing or whitespace', async () => {
      const invalidCredPairs = [
        { email: undefined, pass: 'SecretDemoPassword123!' },
        { email: 'demo@cafe.com', pass: undefined },
        { email: '   ', pass: 'SecretDemoPassword123!' },
        { email: 'demo@cafe.com', pass: '   ' },
      ];

      for (const { email, pass } of invalidCredPairs) {
        vi.resetModules();
        if (email === undefined) delete process.env.DEMO_OWNER_EMAIL; else process.env.DEMO_OWNER_EMAIL = email;
        if (pass === undefined) delete process.env.DEMO_OWNER_PASSWORD; else process.env.DEMO_OWNER_PASSWORD = pass;

        const { getDemoPosClient } = await import('../pos-client.mjs');
        await expect(getDemoPosClient()).rejects.toThrow('Demo credentials missing');
      }
    });

    it('treats whitespace-only POS_SUPABASE_ANON_KEY as missing', async () => {
      process.env.POS_SUPABASE_ANON_KEY = '   ';
      const { getDemoPosClient } = await import('../pos-client.mjs');

      await expect(getDemoPosClient()).rejects.toThrow('POS_SUPABASE_ANON_KEY is not configured');
    });

    it('refuses lookalike staging URL before creating a client in demo mode', async () => {
      process.env.POS_SUPABASE_URL = 'https://ljnzschozufepfpkzwjy.supabase.co.attacker.com';
      const { getDemoPosClient } = await import('../pos-client.mjs');

      await expect(getDemoPosClient()).rejects.toThrow(/SAFETY ABORT/);
      expect(createClientMock).not.toHaveBeenCalled();
    });

    it('sanitizes client factory exceptions throwing SAFETY ABORT <credential>', async () => {
      const credentialCanary = 'CANARY_FACTORY_SAFETY_ABORT_123';
      createClientMock.mockImplementationOnce(() => {
        throw new Error(`SAFETY ABORT ${credentialCanary}`);
      });

      const { getDemoPosClient } = await import('../pos-client.mjs');

      try {
        await getDemoPosClient();
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).toBe('POS staging client creation failed');
        expect(err.message).not.toContain(credentialCanary);
        expect(Object.values(err)).not.toContain(credentialCanary);
        expect(JSON.stringify(err)).not.toContain(credentialCanary);
      }
    });

    it('sanitizes sign-in rejections throwing not configured <credential>', async () => {
      const credentialCanary = 'CANARY_REJECT_NOT_CONFIGURED_456';
      signInWithPasswordMock.mockRejectedValueOnce(new Error(`not configured ${credentialCanary}`));

      const { getDemoPosClient } = await import('../pos-client.mjs');

      try {
        await getDemoPosClient();
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).toBe('POS staging authentication failed');
        expect(err.message).not.toContain(credentialCanary);
        expect(Object.values(err)).not.toContain(credentialCanary);
        expect(JSON.stringify(err)).not.toContain(credentialCanary);
      }
    });

    it('sanitizes sign-in errors returning { error } containing credential text', async () => {
      const credentialCanary = 'CANARY_RETURNED_ERROR_789';
      signInWithPasswordMock.mockResolvedValueOnce({
        error: { message: `Invalid password containing ${credentialCanary}` },
      });

      const { getDemoPosClient } = await import('../pos-client.mjs');

      try {
        await getDemoPosClient();
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).toBe('POS staging authentication failed');
        expect(err.message).not.toContain(credentialCanary);
        expect(Object.values(err)).not.toContain(credentialCanary);
        expect(JSON.stringify(err)).not.toContain(credentialCanary);
      }
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
          global: { headers: { Authorization: 'Bearer user-token-aaa' }, fetch: expect.any(Function) },
        }
      );
      expect(createClientMock).toHaveBeenCalledWith(
        'https://ljnzschozufepfpkzwjy.supabase.co',
        'anon-key',
        {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: 'Bearer user-token-bbb' }, fetch: expect.any(Function) },
        }
      );
    });

    it('never calls demo sign-in when creating an authenticated client', async () => {
      const { getAuthenticatedPosClient } = await import('../pos-client.mjs');

      getAuthenticatedPosClient('jwt-token-123');

      expect(signInWithPasswordMock).not.toHaveBeenCalled();
    });

    it('throws error when accessToken is missing, empty, or whitespace', async () => {
      const { getAuthenticatedPosClient } = await import('../pos-client.mjs');

      expect(() => getAuthenticatedPosClient('')).toThrow('accessToken is required for authenticated POS client');
      expect(() => getAuthenticatedPosClient('   ')).toThrow('accessToken is required for authenticated POS client');
      expect(() => getAuthenticatedPosClient(null)).toThrow('accessToken is required for authenticated POS client');
    });

    it('refuses lookalike staging URL for authenticated client', async () => {
      process.env.POS_SUPABASE_URL = 'http://ljnzschozufepfpkzwjy.supabase.co';
      const { getAuthenticatedPosClient } = await import('../pos-client.mjs');

      expect(() => getAuthenticatedPosClient('jwt-token')).toThrow(/SAFETY ABORT/);
    });

    it('sanitizes factory creation failures and never propagates token canary strings', async () => {
      const tokenCanary = 'SECRET_CALLER_TOKEN_CANARY_444';
      createClientMock.mockImplementationOnce(() => {
        throw new Error(`Factory failed with token ${tokenCanary}`);
      });

      const { getAuthenticatedPosClient } = await import('../pos-client.mjs');

      try {
        getAuthenticatedPosClient(tokenCanary);
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).toBe('Failed to initialize authenticated POS client');
        expect(err.message).not.toContain(tokenCanary);
        expect(Object.values(err)).not.toContain(tokenCanary);
        expect(JSON.stringify(err)).not.toContain(tokenCanary);
      }
    });
  });
});
