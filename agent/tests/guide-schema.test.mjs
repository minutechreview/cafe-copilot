import { describe, expect, it } from 'vitest';
import { validateProductGuide } from '../guide-schema.mjs';

const fixture = () => ({
  version: '1.0', product: 'Kade POS', articles: [{
    id: 'kitchen-display', title: 'Turn Kitchen display off or on', section: 'Team & setup',
    route: '/dashboard/settings', pages: ['settings', 'kitchen'], roles: ['owner', 'manager'],
    summary: 'Choose whether this shop uses the kitchen screen.',
    steps: ['Open Team & setup.', 'Change Kitchen display in Business profile.'],
    cautions: ['Existing tickets are kept.'], keywords: ['kds', 'kitchen display'],
  }],
});

describe('product guide release contract', () => {
  it('accepts a bounded article with a route from its approved page IDs', () => {
    expect(validateProductGuide(fixture())).toMatchObject({ version: '1.0' });
  });

  it('accepts only the fixed language settings fragment for that page identifier', () => {
    const guide = fixture();
    guide.articles[0].pages = ['language_settings'];
    guide.articles[0].route = '/dashboard/settings#language-settings';
    expect(validateProductGuide(guide)).toBe(guide);
    guide.articles[0].route = '/dashboard/settings#other';
    expect(() => validateProductGuide(guide)).toThrow('Invalid guide route');
  });

  it.each(['https://evil.test', '//evil.test', '/dashboard/settings?business_id=other', '/dashboard/settings#unknown', '/dashboard/settings?business_id=other#language-settings', '/till?orders=1&business_id=other', '/manual/kade-user-manual.pdf'])('rejects non-approved routes: %s', (route) => {
    const guide = fixture();
    guide.articles[0].route = route;
    expect(() => validateProductGuide(guide)).toThrow('Invalid guide route');
  });

  it.each(['constructor', '__proto__', 'https://evil.test', 'nonexistent'])('rejects unknown page IDs: %s', (page) => {
    const guide = fixture();
    guide.articles[0].pages.push(page);
    expect(() => validateProductGuide(guide)).toThrow('Invalid guide page');
  });

  it('rejects empty, duplicate and excessive article collections', () => {
    expect(() => validateProductGuide({ ...fixture(), articles: [] })).toThrow('articles');
    const guide = fixture();
    guide.articles.push(structuredClone(guide.articles[0]));
    expect(() => validateProductGuide(guide)).toThrow('article id');
    expect(() => validateProductGuide({ ...fixture(), articles: Array(81).fill(guide.articles[0]) })).toThrow('articles');
  });

  it('bounds instructional text and rejects unknown roles', () => {
    const guide = fixture();
    guide.articles[0].steps = Array(15).fill('Do this.');
    expect(() => validateProductGuide(guide)).toThrow('steps');
    guide.articles[0].steps = ['x'.repeat(651)];
    expect(() => validateProductGuide(guide)).toThrow('steps');
    guide.articles[0].steps = ['Do this.'];
    guide.articles[0].roles = ['super-admin'];
    expect(() => validateProductGuide(guide)).toThrow('role');
  });
});
