import { MANAGER_PAGES } from './manager-pages.mjs';

export const MAX_GUIDE_BYTES = 160_000;
const ROLES = new Set(['owner', 'manager', 'cashier', 'kitchen', 'staff']);

function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`Invalid guide ${name}`);
}

function textList(value, name, count, maximum, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > count || (!allowEmpty && value.length === 0)) throw new Error(`Invalid guide ${name}`);
  for (const item of value) text(item, name, maximum);
}

// Both the release sync and the runtime use this check: a guide cannot introduce a new route.
export function validateProductGuide(guide) {
  if (!guide || typeof guide !== 'object' || Array.isArray(guide)) throw new Error('Invalid product guide');
  text(guide.version, 'version', 40);
  text(guide.product, 'product', 80);
  if (!Array.isArray(guide.articles) || !guide.articles.length || guide.articles.length > 80) throw new Error('Invalid guide articles');
  const ids = new Set();
  for (const article of guide.articles) {
    if (!article || typeof article !== 'object' || typeof article.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(article.id) || ids.has(article.id)) throw new Error('Invalid guide article id');
    ids.add(article.id);
    text(article.title, 'title', 140);
    text(article.summary, 'summary', 1_000);
    text(article.section, 'section', 100);
    textList(article.steps, 'steps', 14, 650);
    textList(article.cautions, 'cautions', 10, 700, true);
    textList(article.keywords, 'keywords', 36, 100);
    textList(article.roles, 'roles', 5, 20);
    if (article.roles.some((role) => !ROLES.has(role))) throw new Error('Invalid guide role');
    textList(article.pages, 'pages', 4, 40);
    if (article.pages.some((page) => !Object.hasOwn(MANAGER_PAGES, page))) throw new Error('Invalid guide page');
    if (!article.pages.some((page) => MANAGER_PAGES[page].to === article.route)) throw new Error('Invalid guide route');
  }
  return guide;
}
