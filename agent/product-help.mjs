import guide from './knowledge/product-guide.json' with { type: 'json' };
import { validateProductGuide } from './guide-schema.mjs';
import { normalisePageLinks } from './manager-pages.mjs';

const MAX_QUERY_CHARS = 400;
const MAX_RESULTS = 3;
const STOP_WORDS = new Set('a an and are as at be can could did do does for from get give go have how i in is it me my of on or please show that the them there these this to us use we what when where which who with would you your'.split(' '));

function terms(value) {
  return [...new Set(value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !STOP_WORDS.has(word)).map((word) => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))].slice(0, 60);
}

const normalized = (value) => terms(value).join(' ');
const articles = validateProductGuide(guide).articles.map((article) => {
  const weights = new Map();
  for (const [values, weight] of [[[article.title], 6], [article.keywords, 5], [[article.summary, article.section], 2], [[...article.steps, ...article.cautions], 1]]) {
    for (const word of terms(values.join(' '))) weights.set(word, Math.max(weights.get(word) || 0, weight));
  }
  return { article, weights, phrases: article.keywords.map(normalized).filter((phrase) => phrase.includes(' ')) };
});

export const productHelpToolSpec = {
  toolSpec: {
    name: 'get_product_help',
    description: 'Find verified Kade product-guide instructions for how to use the POS, where to find a feature, app language settings for English/Tamil/Sinhala and Arabic coming soon, customer receipt/menu languages, kitchen on/off, staff PINs, close the day, leave register versus sign out, receipts/refunds, scanning, customization, menu, recipes, stock, purchase orders and reports. Search this guide FIRST for how-to or navigation questions instead of reading business numbers or guessing. It reads bundled instructions only, performs no business-data query and makes no changes. Returned page links open approved app pages.',
    inputSchema: { json: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 2, maxLength: MAX_QUERY_CHARS, description: 'The feature or how-to question in plain English to match the guide source; translate a Tamil/Sinhala question for this search while answering in the chosen app language. Native language names also match. Up to 400 characters.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: 'Maximum matching articles; default 2.' },
      }, required: ['query'],
    } },
  },
};

export function getProductHelp(input, ctx) {
  const principal = ctx?.principal;
  if (!principal || typeof principal.businessId !== 'string' || !principal.businessId || typeof principal.actorId !== 'string' || !principal.actorId || !['authenticated', 'demo'].includes(principal.accessMode) || ctx.businessId !== principal.businessId) throw new Error('Invalid business context');
  if (ctx.signal?.aborted) { const error = new Error('Request cancelled'); error.name = 'AbortError'; throw error; }
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'query') || Object.keys(input).some((key) => !['query', 'limit'].includes(key))) throw new Error('Choose a product help question');
  if (typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.length > MAX_QUERY_CHARS) throw new Error('Choose a product help question of up to 400 characters');
  const limit = input.limit ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error('Choose up to three guide articles');
  const queryTerms = terms(input.query);
  const query = queryTerms.join(' ');
  const matches = articles.map(({ article, weights, phrases }, index) => ({
    article, index,
    score: queryTerms.reduce((total, word) => total + (weights.get(word) || 0), 0) + phrases.reduce((total, phrase) => total + (query.includes(phrase) ? 12 : 0), 0),
  })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(({ article }) => ({
    id: article.id, title: article.title, section: article.section, summary: article.summary,
    steps: [...article.steps], cautions: [...article.cautions], roles: [...article.roles],
    pageLinks: normalisePageLinks(article.pages.map((page) => ({ page }))),
  }));
  return {
    kind: 'product_help', product: guide.product, guide_version: guide.version,
    found: matches.length > 0, articles: matches,
    pageLinks: normalisePageLinks(matches.flatMap((article) => article.pageLinks)), read_only: true,
    guidance: matches.length ? 'Explain the matching steps and relevant cautions in plain language. Page links only open a feature; the user must make and confirm their own changes. These instructions do not reveal this shop\'s current settings or prove an action happened.' : 'The product guide has no matching instructions. Ask the user which feature they mean. Do not invent a feature, route or workflow.',
  };
}
