import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const signInWithPasswordMock = vi.fn();
const createClientMock = vi.fn().mockImplementation(() => ({
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
    delete process.env.DEMO_OWNER_EMAIL;
    delete process.env.DEMO_OWNER_PASSWORD;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('signs in with the default demo owner credentials and returns the client', async () => {
    signInWithPasswordMock.mockResolvedValueOnce({ error: null });
    const { getPosClient } = await import('../pos-client.mjs');

    const supabase = await getPosClient();

    expect(createClientMock).toHaveBeenCalledWith(
      'https://ljnzschozufepfpkzwjy.supabase.co',
      'anon-key',
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: 'cafe-copilot-demo@example.com',
      password: 'CafeCopilot-Demo-2026!',
    });
    expect(supabase).toBeDefined();
  });

  it('caches the authenticated client across calls (single sign-in)', async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    const { getPosClient } = await import('../pos-client.mjs');

    await getPosClient();
    await getPosClient();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-staging URL before ever creating a client', async () => {
    process.env.POS_SUPABASE_URL = 'https://iveygqneqlsxvdvdxxgx.supabase.co';
    const { getPosClient } = await import('../pos-client.mjs');

    await expect(getPosClient()).rejects.toThrow(/SAFETY ABORT/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('rejects a missing anon key', async () => {
    delete process.env.POS_SUPABASE_ANON_KEY;
    const { getPosClient } = await import('../pos-client.mjs');

    await expect(getPosClient()).rejects.toThrow('POS_SUPABASE_ANON_KEY is not configured');
  });

  it('wraps a failed sign-in in a plain error and does not cache the failure', async () => {
    signInWithPasswordMock
      .mockResolvedValueOnce({ error: { message: 'invalid credentials' } })
      .mockResolvedValueOnce({ error: null });
    const { getPosClient } = await import('../pos-client.mjs');

    await expect(getPosClient()).rejects.toThrow('POS staging authentication failed: invalid credentials');

    // Next call retries instead of replaying the cached failure.
    await expect(getPosClient()).resolves.toBeDefined();
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(2);
  });
});
