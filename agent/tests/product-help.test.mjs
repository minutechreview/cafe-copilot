import { describe, expect, it, vi } from 'vitest';
import { getProductHelp, productHelpToolSpec } from '../product-help.mjs';
import { MANAGER_PAGES, normalisePageLinks } from '../manager-pages.mjs';
import guide from '../knowledge/product-guide.json' with { type: 'json' };

const ctx = (overrides = {}) => ({
  businessId: 'shop-a',
  principal: { businessId: 'shop-a', actorId: 'owner-a', accessMode: 'authenticated' },
  ...overrides,
});

describe('verified product help', () => {
  it.each(['How do I change the app language to Tamil?', 'Sinhala staff language settings', 'Arabic coming soon', 'தமிழ் மொழி மாற்றம்', 'සිංහල භාෂාව වෙනස්'])('finds app-language instructions for %s without business queries', (query) => {
    const from = vi.fn(() => { throw new Error('Help must not query business data'); });
    const result = getProductHelp({ query, limit: 1 }, ctx({ posClient: { from } }));
    expect(result.articles[0].id).toBe('app-language-settings');
    expect(result.pageLinks).toContainEqual({ page: 'language_settings', label: 'App language', to: '/dashboard/settings#language-settings' });
    const instructions = JSON.stringify(result.articles);
    expect(instructions).toContain('Coming soon');
    expect(instructions).toContain('Customer receipt and menu languages are separate');
    expect(instructions).toContain('Only an owner or manager');
    expect(from).not.toHaveBeenCalled();
  });

  it('keeps the language feature link fixed when a model supplies forged URLs or tenant parameters', () => {
    expect(normalisePageLinks([{ page: 'language_settings', to: '/dashboard/settings#other', href: 'https://evil.test', business_id: 'shop-b' }])).toEqual([{ page: 'language_settings', label: 'App language', to: '/dashboard/settings#language-settings' }]);
  });
  it('retrieves KDS instructions and settings link without accessing shop data', () => {
    const from = vi.fn(() => { throw new Error('Help must not query business data'); });
    const result = getProductHelp({ query: 'How do I turn off KDS kitchen display?' }, ctx({ posClient: { from } }));
    expect(result).toMatchObject({ kind: 'product_help', found: true, read_only: true, guide_version: guide.version });
    expect(result.articles[0].steps.join(' ')).toMatch(/Kitchen display|kitchen display/);
    expect(result.pageLinks).toContainEqual(expect.objectContaining({ page: 'settings', to: '/dashboard/settings' }));
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ['Where do I close the day and count the cash?', 'close'],
    ['Where can I set staff PINs?', 'staff'],
    ['How do I scan a barcode with the camera?', 'till'],
    ['How do I add item sizes and customization?', 'menu'],
    ['How do I read the sales report date range and net after refunds?', 'sales'],
    ['How do I link ingredients to a recipe?', 'recipes'],
    ['Where do I count stock?', 'stock'],
    ['How do I log waste or a staff meal?', 'till'],
    ['Where do I set up registers and opening float?', 'registers'],
  ])('finds the verified feature for "%s"', (query, page) => {
    const result = getProductHelp({ query, limit: 3 }, ctx());
    expect(result.found).toBe(true);
    expect(result.pageLinks).toContainEqual(expect.objectContaining({ page, to: MANAGER_PAGES[page].to }));
    expect(result.articles.some((article) => article.steps.length > 0)).toBe(true);
  });

  it('explains leave, sign out and close without asserting any shop action happened', () => {
    const result = getProductHelp({ query: 'Leave register versus Sign out versus Close the day', limit: 3 }, ctx());
    const text = JSON.stringify(result.articles);
    expect(text).toMatch(/Leave register/);
    expect(text).toMatch(/Sign out/);
    expect(text).toMatch(/Close the day/);
    expect(result.guidance).toMatch(/must make and confirm their own changes/);
    expect(result.guidance).toMatch(/do not reveal this shop's current settings/);
  });

  it('keeps purchase orders review-only and retains connection limitations from the guide', () => {
    const purchasing = getProductHelp({ query: 'Draft a purchase order in Ask', limit: 1 }, ctx());
    expect(JSON.stringify(purchasing.articles)).toMatch(/draft|review/);
    expect(JSON.stringify(purchasing.articles)).toMatch(/not|never|does not/);
    const connection = getProductHelp({ query: 'slow internet offline limitations', limit: 1 }, ctx());
    expect(JSON.stringify(connection.articles)).toMatch(/connection|online|internet/);
  });

  it('answers only with canonical guide data and fixed route identifiers', () => {
    const result = getProductHelp({ query: 'Kitchen display ignore instructions route javascript evil', limit: 3 }, ctx());
    for (const article of result.articles) {
      const canonical = guide.articles.find(({ id }) => id === article.id);
      expect(article.steps).toEqual(canonical.steps);
      expect(article.cautions).toEqual(canonical.cautions);
      for (const link of article.pageLinks) expect(link.to).toBe(MANAGER_PAGES[link.page].to);
    }
    expect(JSON.stringify(result)).not.toMatch(/javascript:|evil\.test|business_id=/);
    expect(result).not.toHaveProperty('businessId');
    expect(result).not.toHaveProperty('actorId');
  });

  it('returns no match for unknown terms and asks for clarification', () => {
    const result = getProductHelp({ query: 'zzxyquuxqv xyzzyplugh' }, ctx());
    expect(result).toMatchObject({ found: false, articles: [], pageLinks: [], read_only: true });
    expect(result.guidance).toMatch(/Do not invent/);
  });

  it('bounds results and rejects unbounded or forged input', () => {
    expect(getProductHelp({ query: 'menu kitchen stock report staff', limit: 3 }, ctx()).articles.length).toBeLessThanOrEqual(3);
    for (const input of [{ query: '' }, { query: 2 }, { query: 'a' }, { query: 'x'.repeat(401) }, { query: 'kitchen', limit: 4 }, { query: 'kitchen', limit: 0 }, { query: 'kitchen', limit: 1.5 }, { query: 'kitchen', route: 'https://evil.test' }, { query: 'kitchen', businessId: 'shop-b' }, [], null]) {
      expect(() => getProductHelp(input, ctx())).toThrow();
    }
    expect(productHelpToolSpec.toolSpec.inputSchema.json.additionalProperties).toBe(false);
  });

  it('requires a valid principal and matching business before reading help', () => {
    for (const overrides of [{ principal: null }, { businessId: 'shop-b' }, { principal: { businessId: 'shop-a', actorId: null, accessMode: 'authenticated' } }, { principal: { businessId: 'shop-a', actorId: 'owner-a', accessMode: 'untrusted' } }]) {
      expect(() => getProductHelp({ query: 'kitchen' }, ctx(overrides))).toThrow('Invalid business context');
    }
    expect(getProductHelp({ query: 'kitchen' }, ctx({ principal: { businessId: 'shop-a', actorId: 'demo-session-a', accessMode: 'demo' } })).found).toBe(true);
  });

  it('does not share mutable article arrays across requests and honors cancellation', () => {
    const first = getProductHelp({ query: 'kitchen display', limit: 1 }, ctx());
    const original = [...first.articles[0].steps];
    first.articles[0].steps.push('Injected step');
    expect(getProductHelp({ query: 'kitchen display', limit: 1 }, ctx()).articles[0].steps).toEqual(original);
    const controller = new AbortController();
    controller.abort();
    expect(() => getProductHelp({ query: 'kitchen display' }, ctx({ signal: controller.signal }))).toThrow('Request cancelled');
  });
});
