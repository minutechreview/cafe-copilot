import { ActionValidationError } from './registry.mjs';

export const ACTION_TARGET_KINDS = Object.freeze([
  'menu_item', 'inventory_item', 'supplier', 'open_till_session',
  'draft_purchase_order', 'operational_record',
]);

function deny(message, code = 'INVALID_TARGET_SEARCH') {
  throw new ActionValidationError(message, code);
}

function assertInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) deny('target search input must be an object');
  for (const key of Object.keys(input)) if (!['kind', 'query'].includes(key)) deny(`target search contains unknown field: ${key}`);
  if (!ACTION_TARGET_KINDS.includes(input.kind)) deny('target kind is not allowlisted');
  if (typeof input.query !== 'string' || input.query !== input.query.trim() || input.query.length < 1 || input.query.length > 80) deny('query must be a trimmed string of 1..80 characters');
  return input;
}

function assertPrincipal(ctx) {
  if (!ctx?.principal || ctx.principal.accessMode !== 'authenticated' || !ctx.principal.businessId || !ctx.principal.actorId) {
    deny('Action target discovery requires an authenticated principal', 'ACTION_DENIED');
  }
}

function withSignal(query, signal) {
  return signal && typeof query?.abortSignal === 'function' ? query.abortSignal(signal) : query;
}

async function rows(query, signal) {
  const result = await withSignal(query, signal);
  if (result?.error) deny('Action targets could not be retrieved', 'TARGET_UNAVAILABLE');
  return Array.isArray(result?.data) ? result.data : [];
}

async function trustedCurrency(ctx) {
  if (typeof ctx.businessContext?.currency === 'string' && ctx.businessContext.currency) return ctx.businessContext.currency;
  let query = ctx.posClient.from('businesses').select('id,currency').eq('id', ctx.principal.businessId).limit(1);
  if (typeof query.maybeSingle === 'function') query = query.maybeSingle();
  const result = await withSignal(query, ctx.signal);
  if (result?.error || result?.data?.id !== ctx.principal.businessId || typeof result.data.currency !== 'string') deny('Trusted business currency is unavailable', 'TARGET_UNAVAILABLE');
  return result.data.currency;
}

function escapedContains(value) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

async function posTargets(kind, query, ctx) {
  if (!ctx.posClient) deny('Trusted caller POS context is required', 'ACTION_DENIED');
  const businessId = ctx.principal.businessId;
  const pattern = escapedContains(query);
  let builder;
  if (kind === 'menu_item') {
    builder = ctx.posClient.from('menu_items').select('id,name,revision,price,available').eq('business_id', businessId).eq('active', true).ilike('name', pattern).order('name', { ascending: true }).limit(10);
  } else if (kind === 'inventory_item') {
    builder = ctx.posClient.from('inventory_items').select('id,name,revision,unit,operational_availability').eq('business_id', businessId).ilike('name', pattern).order('name', { ascending: true }).limit(10);
  } else if (kind === 'supplier') {
    builder = ctx.posClient.from('suppliers').select('id,name').eq('business_id', businessId).ilike('name', pattern).order('name', { ascending: true }).limit(10);
  } else if (kind === 'open_till_session') {
    builder = ctx.posClient.from('till_sessions').select('id,till_id,opened_at,tills!till_sessions_business_till_fkey!inner(id,name)').eq('business_id', businessId).is('closed_at', null).ilike('tills.name', pattern).order('opened_at', { ascending: true }).limit(10);
  } else if (kind === 'draft_purchase_order') {
    builder = ctx.posClient.from('purchase_orders').select('id,revision,status,supplier_id,suppliers!purchase_orders_business_id_supplier_id_fkey!inner(id,name)').eq('business_id', businessId).eq('status', 'draft').ilike('suppliers.name', pattern).order('created_at', { ascending: false }).limit(10);
  } else {
    deny('target kind is not a POS target kind');
  }
  const data = await rows(builder, ctx.signal);
  const currency = kind === 'menu_item' ? await trustedCurrency(ctx) : null;
  return data.slice(0, 10).map((row) => {
    if (kind === 'menu_item') return { kind, id: row.id, name: row.name, label: row.name, revision: row.revision, state: row.available ? 'available' : 'unavailable', currency, price: String(row.price) };
    if (kind === 'inventory_item') return { kind, id: row.id, name: row.name, label: row.name, revision: row.revision, state: row.operational_availability, unit: row.unit };
    if (kind === 'supplier') return { kind, id: row.id, name: row.name, label: row.name };
    if (kind === 'open_till_session') {
      const tillName = row.tills?.name ?? 'Till';
      return { kind, id: row.id, name: tillName, label: `${tillName} — open session`, state: 'open', tillId: row.till_id };
    }
    const supplierName = row.suppliers?.name ?? 'Supplier';
    return { kind, id: row.id, name: supplierName, label: `Draft PO — ${supplierName}`, revision: row.revision, state: 'draft', supplierId: row.supplier_id };
  });
}

async function operationalTargets(query, ctx) {
  const store = ctx?.actionDependencies?.operationalStore;
  if (!store || typeof store.findOperationalRecords !== 'function') deny('Operational target discovery is unavailable', 'TARGET_UNAVAILABLE');
  const found = await store.findOperationalRecords(ctx.principal, { query, statuses: ['open'], limit: 10 }, { signal: ctx.signal });
  if (!Array.isArray(found)) deny('Operational target discovery returned an invalid result', 'TARGET_UNAVAILABLE');
  return found.slice(0, 10).map((record) => {
    if (record.businessId !== ctx.principal.businessId || record.status !== 'open') deny('Operational target scope mismatch', 'TARGET_UNAVAILABLE');
    return { kind: 'operational_record', id: record.id, name: record.title, label: record.title, revision: record.version, state: record.status };
  });
}

export async function findActionTargets(input, ctx) {
  assertPrincipal(ctx);
  const { kind, query } = assertInput(input);
  const targets = kind === 'operational_record' ? await operationalTargets(query, ctx) : await posTargets(kind, query, ctx);
  return { kind, query, targets };
}
