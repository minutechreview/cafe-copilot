import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalSha256, sha256 } from './canonical.mjs';
import {
  ACTION_SCHEMA_VERSION, ACTION_REGISTRY, CURRENCY_SCALES, ActionValidationError,
  encodeActionPayload, getActionDefinition, hashActionPayload, validateModelActionInput,
} from './registry.mjs';

const PROPOSAL_LIMIT = 10;
const PROPOSAL_WINDOW_MS = 60_000;
const EXPORT_COLUMNS = Object.freeze({
  sales: ['business_date', 'gross_sales', 'order_count', 'average_transaction_value'],
  waste: ['occurred_at', 'item', 'quantity', 'unit', 'reason'],
  staff_performance: ['staff', 'sales', 'orders', 'average_transaction_value'],
  cash_reconciliation: ['business_date', 'expected_cash', 'counted_cash', 'variance'],
  inventory: ['item', 'unit', 'current_stock', 'operational_availability'],
});

function deny(message, code = 'ACTION_DENIED') { throw new ActionValidationError(message, code); }
function assertAuthenticated(principal) {
  if (!principal || principal.accessMode !== 'authenticated' || typeof principal.businessId !== 'string' || typeof principal.actorId !== 'string') {
    deny('Actions require an authenticated owner or manager context');
  }
}
function pos(ctx) { if (!ctx?.posClient) deny('Trusted caller POS context is required'); return ctx.posClient; }
function queryWithSignal(query, signal) { return signal && typeof query?.abortSignal === 'function' ? query.abortSignal(signal) : query; }
async function one(query, label, signal) {
  const result = await queryWithSignal(typeof query?.maybeSingle === 'function' ? query.maybeSingle() : query, signal);
  if (result?.error) deny(`Unable to resolve ${label}`, 'TARGET_UNAVAILABLE');
  if (!result?.data) deny(`${label} was not found in this business`, 'TARGET_NOT_FOUND');
  return result.data;
}
async function list(query, label, signal) {
  const result = await queryWithSignal(query, signal);
  if (result?.error) deny(`Unable to resolve ${label}`, 'TARGET_UNAVAILABLE');
  return result?.data ?? [];
}

async function businessContext(ctx) {
  if (ctx.businessContext?.currency && CURRENCY_SCALES[ctx.businessContext.currency]) {
    return { id: ctx.principal.businessId, currency: ctx.businessContext.currency };
  }
  const business = await one(pos(ctx).from('businesses').select('id,currency').eq('id', ctx.principal.businessId), 'business', ctx.signal);
  if (business.id !== ctx.principal.businessId || !CURRENCY_SCALES[business.currency]) deny('Business currency is action-disabled', 'UNSUPPORTED_CURRENCY');
  return { id: business.id, currency: business.currency };
}

/** Default closed policy is off. Production injects a caller-scoped POS policy resolver. */
export async function resolveActionPolicy(ctx, action) {
  const resolver = ctx?.actionDependencies?.resolvePolicy ?? ctx?.resolveActionPolicy;
  const value = typeof resolver === 'function'
    ? await resolver({ businessId: ctx.principal.businessId, actorId: ctx.principal.actorId, action, posClient: ctx.posClient, signal: ctx.signal })
    : ctx?.actionPolicy;
  if (!value || value.globalEnabled !== true || value.businessEnabled !== true || value.actionEnabled !== true || !Number.isSafeInteger(value.version) || value.version < 0) {
    deny('Actions are not enabled for this business', 'ACTION_DISABLED');
  }
  return { version: value.version };
}

async function consumeProposalLimit(ctx, action) {
  const limiter = ctx?.actionDependencies?.proposalLimiter;
  if (!limiter || typeof limiter.consume !== 'function') deny('Action proposal limiting is unavailable', 'ACTION_DISABLED');
  const result = await limiter.consume({ businessId: ctx.principal.businessId, actorId: ctx.principal.actorId, action, limit: PROPOSAL_LIMIT, windowMs: PROPOSAL_WINDOW_MS, signal: ctx.signal });
  if (!(result === true || result?.allowed === true)) deny('Too many action proposals; try again shortly', 'ACTION_RATE_LIMITED');
}

async function resolvePassiveTarget(action, input, ctx) {
  if (action.endsWith('.create')) return null;
  const store = ctx?.actionDependencies?.operationalStore;
  if (!store || typeof store.getOperationalRecord !== 'function') deny('Operational record lookup is unavailable', 'ACTION_DISABLED');
  const record = await store.getOperationalRecord(ctx.principal, input.recordId, { signal: ctx.signal });
  const expectedType = action.split('.')[1];
  if (!record || record.businessId !== ctx.principal.businessId || record.recordType !== expectedType) deny('Operational record was not found in this business', 'TARGET_NOT_FOUND');
  if (record.status !== 'open') deny('Operational record state has changed', 'TARGET_CHANGED');
  if (!Number.isSafeInteger(record.version) || record.version < 1) deny('Operational record version is unavailable', 'TARGET_UNAVAILABLE');
  return { kind: 'operational_record', row: record };
}

async function resolveTarget(action, input, ctx) {
  if (action === 'navigation.open' || action === 'report.export_handoff') return null;
  if (action.startsWith('ops.')) return resolvePassiveTarget(action, input, ctx);
  const p = pos(ctx); const businessId = ctx.principal.businessId;
  if (action === 'purchase_order.draft.create') {
    if (new Set(input.lines.map((line) => line.inventoryItemId)).size !== input.lines.length) deny('Purchase order lines must not repeat an inventory item', 'INVALID_ACTION_INPUT');
    const supplier = await one(p.from('suppliers').select('id,name').eq('business_id', businessId).eq('id', input.supplierId), 'supplier', ctx.signal);
    const ids = input.lines.map((line) => line.inventoryItemId).sort();
    const items = await list(p.from('inventory_items').select('id,revision,name,unit').eq('business_id', businessId).in('id', ids).order('id', { ascending: true }), 'purchase-order items', ctx.signal);
    const sortedItems = [...items].sort((left, right) => left.id.localeCompare(right.id));
    if (sortedItems.length !== ids.length || sortedItems.some((item, index) => item.id !== ids[index])) deny('Each purchase-order item must belong to this business', 'TARGET_NOT_FOUND');
    if (sortedItems.some((item) => !item.unit || !Number.isSafeInteger(item.revision))) deny('Purchase-order item snapshot is incomplete', 'TARGET_UNAVAILABLE');
    return { kind: 'supplier', supplier, items: sortedItems };
  }
  const targetId = input.targetId;
  if (action === 'purchase_order.draft.cancel') return { kind: 'purchase_order', row: await one(p.from('purchase_orders').select('id,revision,status,supplier_id').eq('business_id', businessId).eq('id', targetId).eq('status', 'draft'), 'draft purchase order', ctx.signal) };
  if (action.startsWith('menu.') || action === 'waste.record') return { kind: 'menu_item', row: await one(p.from('menu_items').select('id,revision,name,price,active,available').eq('business_id', businessId).eq('id', targetId).eq('active', true), 'active menu item', ctx.signal) };
  if (action.startsWith('ingredient.') || action.startsWith('stock.')) {
    const row = await one(p.from('inventory_items').select('id,revision,name,unit,operational_availability,availability_reason,current_stock').eq('business_id', businessId).eq('id', targetId), 'inventory item', ctx.signal);
    if (action === 'ingredient.availability.set') {
      const recipes = await list(p.from('recipe_items').select('inventory_item_id,menu_item_id,qty_per_unit,menu_items!inner(id,revision,name,active,available)').eq('business_id', businessId).eq('inventory_item_id', targetId).order('menu_item_id', { ascending: true }), 'recipe impact', ctx.signal);
      const recipeImpact = recipes.map((recipe) => {
        const rawQuantity = String(recipe.qty_per_unit);
        const qtyPerUnit = rawQuantity.includes('.') ? rawQuantity.padEnd(rawQuantity.indexOf('.') + 4, '0') : `${rawQuantity}.000`;
        return { inventoryItemId: recipe.inventory_item_id, menuItemId: recipe.menu_item_id, menuItemName: recipe.menu_items?.name ?? 'Menu item', qtyPerUnit, menuItemRevision: recipe.menu_items?.revision ?? null, menuItemActive: recipe.menu_items?.active ?? null, menuItemAvailable: recipe.menu_items?.available ?? null };
      }).sort((left, right) => left.menuItemId.localeCompare(right.menuItemId));
      return { kind: 'inventory_item', row, recipeImpact };
    }
    return { kind: 'inventory_item', row };
  }
  if (action === 'cash.paid_in_out.record') {
    const session = await one(p.from('till_sessions').select('id,opened_at,closed_at,till_id,tills!till_sessions_business_till_fkey(id,name)').eq('business_id', businessId).eq('id', targetId).is('closed_at', null), 'open till session', ctx.signal);
    const tillName = session.tills?.name;
    if (!tillName || !session.till_id) deny('Open till session label is unavailable', 'TARGET_UNAVAILABLE');
    return { kind: 'till_session', row: { ...session, name: `${tillName} — open session` } };
  }
  deny('Action target resolution is not allowlisted', 'UNKNOWN_ACTION');
}

function exportDescriptor(input) {
  const columns = EXPORT_COLUMNS[input.reportKind];
  if (!columns) deny('Report kind is not allowlisted', 'INVALID_ACTION_INPUT');
  return { ...input, columns, rowLimit: 10_000, filename: `${input.reportKind}_${input.startDate}_${input.endDate}.csv` };
}

function materialize(action, original, target) {
  if (action === 'report.export_handoff') return exportDescriptor(original);
  if (action === 'cash.paid_in_out.record') return { ...original, expectedOpen: true };
  if (action === 'purchase_order.draft.create') {
    const quantities = new Map(original.lines.map((line) => [line.inventoryItemId, line.quantity]));
    const lines = target.items.map((item) => ({ inventoryItemId: item.id, quantity: quantities.get(item.id), unit: item.unit, itemRevision: item.revision }));
    const snapshotHash = canonicalSha256({ supplier: target.supplier, items: target.items });
    return { supplierId: original.supplierId, lines, snapshotHash };
  }
  if (action.startsWith('ops.') && target?.row) return { ...original, expectedVersion: target.row.version };
  if (target?.row) return { ...original, expectedRevision: target.row.revision };
  return original;
}

function effect(action, payload, target, currency) {
  const row = target?.row;
  const baseTarget = { kind: target?.kind ?? (action.startsWith('ops.') ? 'operational_record' : action === 'navigation.open' ? 'navigation' : action === 'report.export_handoff' ? 'report_export' : 'descriptor'), id: row?.id ?? target?.supplier?.id ?? payload.recordId ?? payload.targetId ?? null, label: row?.name ?? target?.supplier?.name ?? payload.title ?? payload.reportKind ?? payload.surface ?? action };
  if (action === 'cash.paid_in_out.record') baseTarget.till = { id: row.till_id, label: row.tills.name };
  let before = null; let after = null; let impact = { warnings: [] };
  if (action === 'menu.availability.set') { before = { available: row.available, revision: row.revision }; after = { available: payload.available }; }
  else if (action === 'menu.price.set') { before = { price: String(row.price), currency, revision: row.revision }; after = { price: payload.price, currency }; }
  else if (action === 'ingredient.availability.set') { before = { availability: row.operational_availability, reason: row.availability_reason, revision: row.revision }; after = { availability: payload.availability, reason: payload.reason }; impact = { warnings: [], affectedMenuItems: target.recipeImpact, snapshotHash: payload.recipeImpactHash }; }
  else if (action === 'waste.record') { before = { ledger: 'unchanged', unit: 'item', revision: row.revision }; after = { quantity: payload.quantity, unit: 'item', reason: payload.reason }; }
  else if (action === 'cash.paid_in_out.record') { before = { open: row.closed_at == null, openedAt: row.opened_at }; after = { direction: payload.direction, amount: payload.amount, currency, reason: payload.reason }; }
  else if (action === 'stock.count.correct') { before = { count: String(row.current_stock), unit: row.unit, revision: row.revision }; after = { count: payload.count, unit: row.unit, reason: payload.reason }; }
  else if (action === 'purchase_order.draft.create') { after = { status: 'draft', supplier: { id: target.supplier.id, label: target.supplier.name }, lines: payload.lines }; impact = { warnings: [], snapshotHash: payload.snapshotHash }; }
  else if (action === 'purchase_order.draft.cancel') { before = { status: row.status, revision: row.revision, supplierId: row.supplier_id }; after = { status: 'cancelled' }; }
  else if (action.startsWith('ops.')) {
    before = row ? { status: row.status, version: row.version, title: row.title, body: row.body } : null;
    const verb = action.split('.')[2]; after = verb === 'create' ? { status: 'open', title: payload.title, body: payload.body, dueAt: payload.dueAt } : verb === 'supersede' ? { status: 'superseded', title: payload.title, body: payload.body, dueAt: payload.dueAt } : { status: verb === 'complete' ? 'completed' : 'cancelled' };
  } else if (action === 'navigation.open') after = { surface: payload.surface, recordId: payload.recordId, businessDate: payload.businessDate };
  else if (action === 'report.export_handoff') after = { reportKind: payload.reportKind, businessDateRange: payload.businessDateRange, columns: payload.columns, rowLimit: payload.rowLimit, filename: payload.filename };
  return { target: baseTarget, before, after, impact };
}

function presentation(action, payload, target, currency) {
  const structuredEffect = effect(action, payload, target, currency);
  const summary = action === 'menu.price.set' ? `Change ${structuredEffect.target.label} to ${currency} ${payload.price}`
    : action === 'navigation.open' ? `Open ${payload.surface}`
      : action === 'report.export_handoff' ? `Prepare ${payload.reportKind} export handoff`
        : `Prepare ${action.replaceAll('.', ' ')} for ${structuredEffect.target.label}`;
  return { summary, effect: structuredEffect };
}

function publicProposal(proposal, nonce, action, definition, view) {
  return { id: proposal.id, action, state: 'proposed', expiresAt: proposal.expiresAt, confirmationNonce: nonce, requires: { chatConfirmation: definition.mutation || action.startsWith('ops.'), managerPin: definition.requiresPin }, summary: view.summary, effect: view.effect, undo: { supported: false, conditions: [] } };
}

function operationKey(ctx, action, operationId) {
  const requestId = typeof operationId === 'object' ? operationId?.requestId : (ctx.actionRequestId ?? ctx.conversationId ?? operationId);
  const toolUseId = typeof operationId === 'object' ? operationId?.toolUseId : operationId;
  if (typeof requestId !== 'string' || !requestId || requestId.length > 256 || typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > 256) deny('Stable request/tool operation identity is required', 'ACTION_OPERATION_REQUIRED');
  return sha256(`proposal-v1\n${ctx.principal.businessId}\n${ctx.principal.actorId}\n${requestId}\n${action}\n${toolUseId}`);
}

async function persistProposal(store, principal, input, options) {
  if (store && typeof store.createOrRotateActionProposal === 'function') {
    const result = await store.createOrRotateActionProposal(principal, input, options);
    if (!result?.proposal?.id || result.nonceBound !== true) deny('Proposal nonce could not be safely bound', 'ACTION_RETRY_UNSAFE');
    return result;
  }
  if (!store || typeof store.createActionProposal !== 'function') throw new Error('action proposal store dependency is required');
  const result = await store.createActionProposal(principal, input, options);
  if (!result?.proposal?.id || result.created !== true) deny('Safe duplicate proposal recovery is unavailable', 'ACTION_RETRY_UNSAFE');
  return result;
}

/** Prepares only. This function never signs a capability or invokes a POS RPC/mutation. */
export async function prepareActionProposal({ action, input, ctx, store, operationId, now = new Date(), random = randomBytes, randomId = randomUUID } = {}) {
  assertAuthenticated(ctx?.principal);
  const definition = getActionDefinition(action);
  validateModelActionInput(action, input);
  const policy = await resolveActionPolicy(ctx, action);
  await consumeProposalLimit(ctx, action);
  const trustedBusiness = await businessContext(ctx);
  const target = await resolveTarget(action, input, ctx);
  const trustedInput = materialize(action, input, target);
  if (action === 'ingredient.availability.set') trustedInput.recipeImpactHash = canonicalSha256(target.recipeImpact);
  const payload = encodeActionPayload(action, trustedInput, { currency: trustedBusiness.currency });
  const payloadHash = hashActionPayload(action, payload);
  const targetSnapshotHash = target ? canonicalSha256(target) : null;
  const expectedStateHash = target?.row ? canonicalSha256({ id: target.row.id, status: target.row.status ?? null, revision: target.row.revision ?? null, version: target.row.version ?? null, closedAt: target.row.closed_at ?? null }) : null;
  const nonce = Buffer.from(random(32)).toString('base64url');
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const idempotencyKey = operationKey(ctx, action, operationId);
  const proposalStore = store ?? ctx?.actionDependencies?.proposalStore ?? ctx?.proposalStore;
  const stored = await persistProposal(proposalStore, ctx.principal, { id: randomId(), actionKey: action, actionVersion: definition.version, policyVersion: policy.version, normalizedPayload: payload, payloadHash, targetSnapshotHash, expectedStateHash, confirmationNonceHash: sha256(nonce), idempotencyKey, expiresAt }, { signal: ctx.signal });
  const view = presentation(action, payload, target, trustedBusiness.currency);
  return { modelResult: { prepared: true, action, summary: view.summary, requires: { chatConfirmation: definition.mutation || action.startsWith('ops.'), managerPin: definition.requiresPin } }, proposal: publicProposal(stored.proposal, nonce, action, definition, view), internal: { action, payload, payloadHash, policyVersion: policy.version, idempotencyKey } };
}

export { ACTION_REGISTRY, ACTION_SCHEMA_VERSION };
