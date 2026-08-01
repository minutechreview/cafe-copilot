// Startup-only composition of trusted action adapters.  This module never accepts adapters,
// keys, RPC names, or tenant identifiers from HTTP input.
import * as proposalStore from '../../memory/store.mjs';
import { createTrustedActionDependencies } from './http.mjs';
import { getAuthenticatedPosClient } from '../pos-client.mjs';

const RPC = Object.freeze({
  'menu.availability.set': 'copilot_set_menu_availability', 'menu.price.set': 'copilot_set_menu_price',
  'ingredient.availability.set': 'copilot_set_ingredient_availability', 'waste.record': 'copilot_record_waste',
  'cash.paid_in_out.record': 'copilot_record_paid_in_out', 'stock.count.correct': 'copilot_record_stock_count',
  'purchase_order.draft.create': 'copilot_create_purchase_order_draft', 'purchase_order.draft.cancel': 'copilot_cancel_purchase_order_draft',
});

// Undo execution is intentionally closed even though undo preparation may be unavailable for a
// particular audit row. No RPC name is ever selected from HTTP/model input.
export const UNDO_RPC = Object.freeze({
  'menu.availability.undo': 'copilot_undo_menu_availability',
  'menu.price.undo': 'copilot_undo_menu_price',
  'ingredient.availability.undo': 'copilot_undo_ingredient_availability',
  'waste.reverse': 'copilot_reverse_waste',
  'cash.paid_in_out.reverse': 'copilot_reverse_paid_in_out',
  'stock.count.undo': 'copilot_undo_stock_count',
  'purchase_order.draft.undo': 'copilot_undo_purchase_order_create',
});

function oneRow(data) {
  return Array.isArray(data) && data.length === 1 && data[0] && typeof data[0] === 'object' ? data[0] : null;
}

function safeVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

function materializeUndoAudit(audit, expectedActionId) {
  if (!audit || audit.action_id !== expectedActionId || audit.status !== 'succeeded' || audit.result_code !== 'OK') return null;
  const eligibleUntil = Date.parse(audit.eligible_until); if (!Number.isFinite(eligibleUntil) || eligibleUntil <= Date.now()) return null;
  const before = audit.before_state; const after = audit.after_state;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
  const parentActionId = audit.action_id; const targetId = audit.target_id; const expectedRevision = Number(audit.after_revision);
  const base = { parentActionId, targetId, expectedRevision };
  let payload;
  if (audit.action_key === 'menu.availability.set' && typeof before.available === 'boolean') payload = { ...base, restoreAvailable: before.available };
  else if (audit.action_key === 'menu.price.set' && typeof before.price === 'string') payload = { ...base, restorePrice: before.price };
  else if (audit.action_key === 'ingredient.availability.set' && typeof before.availability === 'string' && typeof after.impactHash === 'string') payload = { ...base, restoreAvailability: before.availability, expectedImpactHash: after.impactHash };
  else if (audit.action_key === 'stock.count.correct' && typeof before.currentStock === 'string') payload = { ...base, restoreCountedQty: before.currentStock, reason: 'Undo stock count' };
  else if (audit.action_key === 'purchase_order.draft.create') payload = base;
  else if (audit.action_key === 'waste.record') payload = { targetId, reason: 'Undo waste record', originalActionId: parentActionId };
  else if (audit.action_key === 'cash.paid_in_out.record') payload = { targetId, reason: 'Undo cash record', originalActionId: parentActionId };
  else return null;
  return { supported: true, eligibleUntil: audit.eligible_until, payloadSnapshot: payload, presentation: { summary: `Undo ${audit.action_key}`, effect: { target: { kind: audit.target_kind, id: targetId, label: audit.target_kind }, before: after, after: before, impact: { warnings: [] } } } };
}

function pinRejected(error) {
  return error?.code === 'P0001' && error?.message === 'PIN_NOT_ACCEPTED';
}

const DETERMINISTIC_DENIAL = Object.freeze({
  TARGET_CHANGED: { status: 'failed', code: 'TARGET_CHANGED' },
  COPILOT_ACTION_DISABLED: { status: 'stale', code: 'ACTION_DISABLED' },
  COPILOT_CAPABILITY_DENIED: { status: 'failed', code: 'CAPABILITY_DENIED' },
  COPILOT_CAPABILITY_INVALID: { status: 'failed', code: 'CAPABILITY_INVALID' },
  COPILOT_NOT_AUTHORIZED: { status: 'failed', code: 'ACTION_DENIED' },
  COPILOT_VALUE_INVALID: { status: 'failed', code: 'INVALID_ACTION_VALUE' },
  UNDO_UNAVAILABLE: { status: 'failed', code: 'UNDO_UNAVAILABLE' },
});
const UNDOABLE_FORWARD = new Set(['menu.availability.set', 'menu.price.set', 'ingredient.availability.set', 'waste.record', 'cash.paid_in_out.record', 'stock.count.correct', 'purchase_order.draft.create']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function auditTerminalProjection(proposal, row) {
  if (!row || row.proposal_id !== proposal.id || row.status !== 'succeeded' || row.result_code !== 'OK'
    || !UUID.test(row.action_id || '') || (row.target_id !== null && row.target_id !== undefined && !UUID.test(row.target_id))) return null;
  const completedAtMs = Date.parse(row.completed_at);
  if (!Number.isFinite(completedAtMs)) return null;
  const targetRevision = row.target_revision === null || row.target_revision === undefined ? null : Number(row.target_revision);
  if (targetRevision !== null && (!Number.isSafeInteger(targetRevision) || targetRevision < 1)) return null;
  const completedAt = new Date(completedAtMs).toISOString();
  const authoritativeEligibleMs = row.eligible_until === null || row.eligible_until === undefined ? completedAtMs + 5 * 60_000 : Date.parse(row.eligible_until);
  if (!Number.isFinite(authoritativeEligibleMs) || authoritativeEligibleMs <= completedAtMs || authoritativeEligibleMs > completedAtMs + 5 * 60_000) return null;
  const undo = UNDOABLE_FORWARD.has(proposal.actionKey)
    ? { supported: true, eligibleUntil: new Date(authoritativeEligibleMs).toISOString(), conditions: [] }
    : { supported: false, eligibleUntil: null, conditions: [] };
  return { completedAt, result: { targetId: row.target_id ?? null, targetRevision }, undo };
}

function deterministicDenial(error, actionId) {
  if (error?.code !== 'P0001') return null;
  const mapped = DETERMINISTIC_DENIAL[error.message];
  return mapped ? { ...mapped, actionId } : null;
}

function requiredRuntimeEnv(env) {
  return env.COPILOT_ACTIONS_RUNTIME_ENABLED === 'true'
    && typeof env.COPILOT_CAPABILITY_HMAC_KEY === 'string' && env.COPILOT_CAPABILITY_HMAC_KEY.length > 0
    && typeof env.COPILOT_CAPABILITY_KID === 'string' && env.COPILOT_CAPABILITY_KID.length > 0
    && typeof env.CRDB_CONNECTION_STRING === 'string' && env.CRDB_CONNECTION_STRING.length > 0;
}

function rpcArgs(action, proposal, actionId, capability, pin) {
  const p = proposal.normalizedPayload;
  const base = { p_business_id: proposal.businessId, p_action_id: actionId, p_capability: capability };
  if (action === 'menu.availability.set') return { ...base, p_menu_item_id: p.targetId, p_available: p.available, p_expected_revision: p.expectedRevision };
  if (action === 'menu.price.set') return { ...base, p_menu_item_id: p.targetId, p_new_price: p.price, p_expected_revision: p.expectedRevision, p_pin: pin };
  if (action === 'ingredient.availability.set') return { ...base, p_inventory_item_id: p.targetId, p_availability: p.availability, p_reason: p.reason, p_expected_revision: p.expectedRevision, p_expected_impact_hash: p.recipeImpactHash, p_pin: pin };
  if (action === 'waste.record') return { ...base, p_menu_item_id: p.targetId, p_quantity: p.quantity, p_reason: p.reason, p_pin: pin };
  if (action === 'cash.paid_in_out.record') return { ...base, p_till_session_id: p.targetId, p_direction: p.direction, p_amount: p.amount, p_reason: p.reason, p_pin: pin };
  if (action === 'stock.count.correct') return { ...base, p_inventory_item_id: p.targetId, p_counted_qty: p.count, p_expected_revision: p.expectedRevision, p_reason: p.reason, p_pin: pin };
  if (action === 'purchase_order.draft.create') return { ...base, p_supplier_id: p.supplierId, p_lines: p.lines.map((x) => ({ inventory_item_id: x.inventoryItemId, quantity: x.quantity, unit: x.unit, item_revision: x.itemRevision })), p_expected_snapshot_hash: p.snapshotHash };
  if (action === 'purchase_order.draft.cancel') return { ...base, p_purchase_order_id: p.targetId, p_expected_revision: p.expectedRevision };
  if (action === 'menu.availability.undo') return { ...base, p_menu_item_id: p.targetId, p_restore_available: p.restoreAvailable, p_expected_revision: p.expectedRevision, p_parent_action_id: p.parentActionId };
  if (action === 'menu.price.undo') return { ...base, p_menu_item_id: p.targetId, p_restore_price: p.restorePrice, p_expected_revision: p.expectedRevision, p_parent_action_id: p.parentActionId, p_pin: pin };
  if (action === 'ingredient.availability.undo') return { ...base, p_inventory_item_id: p.targetId, p_restore_availability: p.restoreAvailability, p_expected_revision: p.expectedRevision, p_expected_impact_hash: p.expectedImpactHash, p_parent_action_id: p.parentActionId, p_pin: pin };
  if (action === 'waste.reverse') return { ...base, p_waste_log_id: p.targetId, p_reason: p.reason, p_original_action_id: p.originalActionId, p_pin: pin };
  if (action === 'cash.paid_in_out.reverse') return { ...base, p_paid_in_out_event_id: p.targetId, p_reason: p.reason, p_original_action_id: p.originalActionId, p_pin: pin };
  if (action === 'stock.count.undo') return { ...base, p_inventory_item_id: p.targetId, p_restore_counted_qty: p.restoreCountedQty, p_expected_revision: p.expectedRevision, p_reason: p.reason, p_parent_action_id: p.parentActionId, p_pin: pin };
  if (action === 'purchase_order.draft.undo') return { ...base, p_purchase_order_id: p.targetId, p_expected_revision: p.expectedRevision, p_parent_action_id: p.parentActionId };
  throw new Error('closed action registry rejected');
}

export function createConfiguredActionDependencies({ env = process.env, store = proposalStore, createPosClient = getAuthenticatedPosClient } = {}) {
  if (!requiredRuntimeEnv(env)) return createTrustedActionDependencies({ createPosClient });
  return createTrustedActionDependencies({
    proposalStore: store, createPosClient,
    resolvePolicy: async ({ businessId, action, posClient }) => {
      const { data, error } = await posClient.rpc('copilot_get_action_policy', { p_business_id: businessId, p_action_key: action });
      const row = !error ? oneRow(data) : null;
      const version = row ? safeVersion(row.policy_version) : null;
      if (!row || version === null || row.global_enabled !== true || row.business_enabled !== true || row.action_enabled !== true) return null;
      return { globalEnabled: true, businessEnabled: true, actionEnabled: true, version };
    },
    confirmLimiter: async ({ businessId, actorId, limit, windowMs, signal }) =>
      store.consumeActionConfirmLimit({ businessId, actorId, accessMode: 'authenticated' }, { limit, windowSeconds: windowMs / 1000 }, { signal }),
    executor: async ({ proposal, actionId, capability, managerPin, posClient }) => {
      const rpc = RPC[proposal.actionKey] ?? UNDO_RPC[proposal.actionKey]; if (!rpc) throw new Error('closed action registry rejected');
      const { data, error } = await posClient.rpc(rpc, rpcArgs(proposal.actionKey, proposal, actionId, capability, managerPin));
      if (pinRejected(error)) return { status: 'rejected', code: 'PIN_REJECTED', actionId: null };
      const denial = deterministicDenial(error, actionId);
      if (denial) return denial;
      if (error) throw new Error('POS action transport failed');
      const result = oneRow(data);
      if (!result) throw new Error('POS action result was not exactly one row');
      if (result.status !== 'succeeded') return { status: result.status, code: result.result_code, actionId: result.action_id };
      const auditResponse = await posClient.rpc('copilot_get_action_audit_status', { p_business_id: proposal.businessId, p_proposal_id: proposal.id });
      const audit = !auditResponse.error ? auditTerminalProjection(proposal, oneRow(auditResponse.data)) : null;
      if (!audit || auditResponse.data[0].action_id !== result.action_id) throw new Error('authoritative audit detail unavailable');
      return { status: 'succeeded', code: 'OK', actionId: result.action_id, posAuditActionId: result.action_id, authoritativePosAudit: true, ...audit };
    },
    operationalExecutor: async ({ principal, proposal, actionId, confirmationNonceHash, rotatedNonceHash, expectedPolicyVersion, signal }) =>
      store.claimAndExecuteOperationalRecordCommand(principal, {
        proposalId: proposal.id, actionId, confirmationNonceHash, rotatedNonceHash, expectedPolicyVersion,
      }, { signal }),
    reconcile: async ({ principal, proposal, posClient, signal }) => {
      if (!proposal || !['confirming', 'reconciliation_pending'].includes(proposal.state)) return proposal;
      const { data, error } = await posClient.rpc('copilot_get_action_audit_status', {
        p_business_id: principal.businessId, p_proposal_id: proposal.id,
      });
      if (error) throw new Error('audit reconciliation unavailable');
      if (!Array.isArray(data) || data.length === 0) return proposal;
      const row = oneRow(data);
      if (!row || row.proposal_id !== proposal.id || !row.action_id || !['succeeded', 'failed'].includes(row.status)) throw new Error('invalid audit reconciliation row');
      const terminal = row.status === 'succeeded' ? auditTerminalProjection(proposal, row) : null;
      if (row.status === 'succeeded' && !terminal) throw new Error('invalid authoritative success projection');
      return store.recordActionReconciliation(principal, {
        proposalId: proposal.id,
        observation: row.status === 'succeeded' ? 'audit_succeeded' : 'audit_failed',
        actionId: row.action_id,
        posAuditActionId: row.action_id,
        resultCode: row.result_code,
        authoritativeAudit: true,
        metadata: { targetId: row.target_id ?? null, targetRevision: row.target_revision ?? null, completedAt: row.completed_at ?? null },
        ...(terminal ? { terminalResult: terminal } : {}),
      }, { signal });
    },
    history: async ({ principal, posClient, limit, signal }) => {
      const [pos, passive] = await Promise.all([
        posClient.rpc('copilot_list_action_audit', { p_business_id: principal.businessId, p_before_completed_at: null, p_before_id: null, p_limit: limit }),
        store.listOperationalActionHistory(principal, { limit: Math.min(limit, 50) }, { signal }),
      ]);
      if (pos.error || !Array.isArray(pos.data)) throw new Error('POS history unavailable');
      const posItems = pos.data.map((row) => ({ source: 'pos', sourceRank: 1, actionId: row.action_id, proposalId: row.proposal_id, action: row.action_key, status: row.status, code: row.result_code, occurredAt: row.completed_at, summary: row.action_key }));
      const passiveItems = passive.map((item) => ({ ...item, action: item.commandKey, status: item.resultSnapshot.status, code: item.resultSnapshot.code, summary: item.commandKey }));
      const items = [...posItems, ...passiveItems]
        .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)) || b.sourceRank - a.sourceRank || String(b.actionId).localeCompare(String(a.actionId)))
        .slice(0, limit);
      return { items };
    },
    prepareUndo: async ({ principal, proposalId, posClient }) => {
      const original = await store.getActionProposal(principal, proposalId);
      if (!original?.terminalActionId || original.state !== 'succeeded') return null;
      const undoKey = ({
        'menu.availability.set': 'menu.availability.undo', 'menu.price.set': 'menu.price.undo',
        'ingredient.availability.set': 'ingredient.availability.undo', 'waste.record': 'waste.reverse',
        'cash.paid_in_out.record': 'cash.paid_in_out.reverse', 'stock.count.correct': 'stock.count.undo',
        'purchase_order.draft.create': 'purchase_order.draft.undo',
      })[original.actionKey];
      if (!undoKey || !UNDO_RPC[undoKey]) return null;
      const { data, error } = await posClient.rpc('copilot_get_action_audit_detail', { p_business_id: principal.businessId, p_action_id: original.terminalActionId });
      const audit = !error ? oneRow(data) : null;
      const auditUndo = materializeUndoAudit(audit, original.terminalActionId);
      if (!auditUndo || audit.action_key !== original.actionKey) return null;
      return typeof store.prepareActionUndoProposal === 'function'
        ? store.prepareActionUndoProposal(principal, { proposalId, auditUndo }, {})
        : null;
    },
  });
}
