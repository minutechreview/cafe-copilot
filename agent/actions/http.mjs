import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolveAuthContext } from '../auth-context.mjs';
import * as defaultProposalStore from '../../memory/store.mjs';
import { getActionDefinition } from './registry.mjs';
import { signCapability } from './signer.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['succeeded', 'rejected', 'expired', 'cancelled', 'stale', 'failed', 'reconciliation_pending', 'undo_unavailable']);
const CONFIRM_LIMIT = 5;
const LIMIT_WINDOW_MS = 60_000;
const UNDO_DEFINITIONS = Object.freeze({
  'menu.availability.undo': { requiresPin: false }, 'menu.price.undo': { requiresPin: true },
  'ingredient.availability.undo': { requiresPin: true }, 'waste.reverse': { requiresPin: true },
  'cash.paid_in_out.reverse': { requiresPin: true }, 'stock.count.undo': { requiresPin: true },
  'purchase_order.draft.undo': { requiresPin: false },
});

function actionDefinition(action) {
  return UNDO_DEFINITIONS[action] ?? getActionDefinition(action);
}

/** Deliberately terse, client-safe error. Never attach request bodies, PINs, or capabilities. */
export class ActionHttpError extends Error {
  constructor(message, status = 400, code = 'INVALID_ACTION_REQUEST') {
    super(message);
    this.name = 'ActionHttpError';
    this.status = status;
    this.code = code;
  }
}

function deny(message, status = 403, code = 'ACTION_DENIED') {
  throw new ActionHttpError(message, status, code);
}

function exactObject(value, keys, name = 'request body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActionHttpError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ActionHttpError(`${name} contains unknown field: ${key}`);
  return value;
}

function requiredString(value, name, max = 4096) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new ActionHttpError(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ActionHttpError(`${name} must be a canonical UUID`);
  return value;
}

function nonceHash(nonce) {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

function nextNonce() {
  return randomBytes(32).toString('base64url');
}

function isTerminal(state) {
  return TERMINAL.has(state);
}

function publicTerminal(proposal, extra = {}) {
  const status = proposal?.state === 'proposed' || proposal?.state === 'confirming' ? 'reconciliation_pending' : proposal?.state;
  return {
    schemaVersion: 1,
    proposalId: proposal?.id ?? extra.proposalId ?? null,
    actionId: proposal?.terminalActionId ?? extra.actionId ?? null,
    action: proposal?.actionKey ?? extra.action ?? null,
    status: status && TERMINAL.has(status) ? status : 'reconciliation_pending',
    code: proposal?.terminalCode ?? extra.code ?? (status === 'reconciliation_pending' ? 'RECONCILIATION_PENDING' : 'ACTION_UNAVAILABLE'),
    ...(proposal?.terminalMessage || extra.message ? { message: proposal?.terminalMessage ?? extra.message } : {}),
    ...(proposal?.terminalResult?.completedAt || extra.completedAt || proposal?.updatedAt ? { completedAt: proposal?.terminalResult?.completedAt ?? extra.completedAt ?? proposal?.updatedAt } : {}),
    ...(proposal?.terminalResult?.result ? { result: proposal.terminalResult.result } : extra.result ? { result: extra.result } : {}),
    ...(proposal?.terminalResult?.undo ? { undo: proposal.terminalResult.undo } : extra.undo ? { undo: extra.undo } : {}),
  };
}

function actionPrincipal(auth) {
  if (!auth || auth.mode !== 'authenticated' || !auth.userId || !auth.businessId || !auth.accessToken) {
    deny('Approved actions require an authenticated owner or manager.', 403, 'ACTION_DENIED');
  }
  return Object.freeze({ businessId: auth.businessId, actorId: auth.userId, accessMode: 'authenticated', accessToken: auth.accessToken });
}

/**
 * The only supported runtime composition. Deployments may replace the adapter functions, but
 * must do so at process startup -- HTTP input is never used as a dependency selector. The
 * defaults intentionally deny because an in-process rate limiter/policy flag is not authority
 * for a privileged POS write.
 */
export function createTrustedActionDependencies({
  proposalStore = defaultProposalStore,
  resolvePolicy,
  confirmLimiter,
  executor,
  operationalExecutor,
  reconcile,
  history,
  prepareUndo,
  createPosClient,
  capabilitySigner = signCapability,
} = {}) {
  return Object.freeze({ proposalStore, resolvePolicy, confirmLimiter, executor, operationalExecutor, reconcile, history, prepareUndo, createPosClient, capabilitySigner });
}

function requireDependency(value, name) {
  if (typeof value !== 'function') deny(`${name} is unavailable; approved actions remain disabled.`, 503, 'ACTION_DISABLED');
  return value;
}

async function authenticate(headers, businessId, signal) {
  const auth = await resolveAuthContext({ headers, mode: 'authenticated', businessId }, { signal });
  return actionPrincipal(auth);
}

async function authenticateProposalPrincipal(headers, proposalId, dependencies, signal) {
  const actor = await resolveAuthContext({ headers, mode: 'authenticated' }, { signal, allowUnscopedAuthenticatedActor: true });
  if (!actor?.userId || !actor?.accessToken || typeof dependencies.proposalStore?.getActionProposalForActor !== 'function') {
    deny('Action proposal was not found.', 404, 'PROPOSAL_NOT_FOUND');
  }
  const bootstrap = await dependencies.proposalStore.getActionProposalForActor(actor.userId, proposalId, { signal });
  if (!bootstrap?.businessId || bootstrap.actorUserId !== actor.userId) deny('Action proposal was not found.', 404, 'PROPOSAL_NOT_FOUND');
  const principal = await authenticate(headers, bootstrap.businessId, signal);
  return { principal, bootstrap };
}

async function resolvePolicy(dependencies, principal, action, posClient, signal) {
  const resolver = requireDependency(dependencies.resolvePolicy, 'Action policy resolver');
  let policy;
  try {
    policy = await resolver({ businessId: principal.businessId, actorId: principal.actorId, action, posClient, signal });
  } catch {
    deny('Action policy is unavailable; approved actions remain disabled.', 503, 'ACTION_DISABLED');
  }
  if (!policy || policy.globalEnabled !== true || policy.businessEnabled !== true || policy.actionEnabled !== true || !Number.isSafeInteger(policy.version) || policy.version < 0) {
    deny('This approved action is currently disabled.', 403, 'ACTION_DISABLED');
  }
  return Object.freeze({ version: policy.version });
}

async function consumeConfirmLimit(dependencies, principal, signal) {
  const limiter = requireDependency(dependencies.confirmLimiter, 'Durable action confirmation limiter');
  let result;
  try {
    result = await limiter({ businessId: principal.businessId, actorId: principal.actorId, action: 'confirm', limit: CONFIRM_LIMIT, windowMs: LIMIT_WINDOW_MS, signal });
  } catch {
    deny('Action confirmation limiting is unavailable; approved actions remain disabled.', 503, 'ACTION_DISABLED');
  }
  if (!(result === true || result?.allowed === true)) deny('Too many confirmation attempts. Please wait a moment and try again.', 429, 'ACTION_RATE_LIMITED');
}

async function scopedPosClient(dependencies, principal, signal) {
  if (typeof dependencies.createPosClient !== 'function') return undefined;
  try {
    return await dependencies.createPosClient(principal.accessToken, { signal });
  } catch {
    deny('Approved action service is unavailable.', 503, 'ACTION_DISABLED');
  }
}

function parseConfirm(body) {
  exactObject(body, ['proposalId', 'confirmationNonce', 'confirm', 'managerPin']);
  const parsed = {
    proposalId: uuid(body.proposalId, 'proposalId'),
    confirmationNonce: requiredString(body.confirmationNonce, 'confirmationNonce', 512),
  };
  if (body.confirm !== true) throw new ActionHttpError('confirm must be true');
  if (body.managerPin !== undefined) parsed.managerPin = requiredString(body.managerPin, 'managerPin', 128);
  return parsed;
}

function parseUndo(body) {
  exactObject(body, ['proposalId']);
  return { proposalId: uuid(body.proposalId, 'proposalId') };
}

function exactQuery(query, keys) {
  const value = query && typeof query === 'object' ? query : {};
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ActionHttpError(`query contains unknown field: ${key}`);
  return value;
}

function policyMismatchTerminal(proposal) {
  // The old policy version can never be revived by toggling a switch back on: any current
  // version differs from the proposal's signed version, so report it as stale without claiming.
  return publicTerminal({ ...proposal, state: 'stale', terminalCode: 'POLICY_STALE', terminalMessage: 'This proposal is no longer eligible and must be prepared again.' });
}

function capabilityFor({ dependencies, proposal, principal, actionId }) {
  const signer = requireDependency(dependencies.capabilitySigner, 'Capability signer');
  return signer({
    kid: process.env.COPILOT_CAPABILITY_KID,
    actionId,
    proposalId: proposal.id,
    parentActionId: proposal.parentActionId ?? null,
    action: proposal.actionKey,
    businessId: principal.businessId,
    actorUserId: principal.actorId,
    payloadHash: proposal.payloadHash,
    policyVersion: proposal.policyVersion,
  });
}

async function reconcileIfAvailable(dependencies, { principal, proposal, posClient, signal }) {
  if (typeof dependencies.reconcile !== 'function') return proposal;
  try {
    const reconciled = await dependencies.reconcile({ principal, proposal, posClient, signal });
    return reconciled?.proposal ?? reconciled ?? proposal;
  } catch {
    return proposal;
  }
}

async function handleConfirm({ headers, body, dependencies, signal }) {
  const input = parseConfirm(body);
  const store = dependencies.proposalStore;
  if (!store || typeof store.getActionProposal !== 'function' || typeof store.claimActionProposal !== 'function' || typeof store.recordActionTerminal !== 'function') {
    deny('Action proposal storage is unavailable; approved actions remain disabled.', 503, 'ACTION_DISABLED');
  }
  const { principal, bootstrap } = await authenticateProposalPrincipal(headers, input.proposalId, dependencies, signal);
  const proposal = await store.getActionProposal(principal, input.proposalId, { signal }) ?? bootstrap;
  if (!proposal) deny('Action proposal was not found.', 404, 'PROPOSAL_NOT_FOUND');
  if (isTerminal(proposal.state)) return publicTerminal(proposal); // exact terminal replay; never invoke the executor again
  if (proposal.state !== 'proposed') {
    const reconciled = await reconcileIfAvailable(dependencies, { principal, proposal, posClient: await scopedPosClient(dependencies, principal, signal), signal });
    return publicTerminal(reconciled);
  }
  if (proposal.businessId !== principal.businessId || proposal.actorUserId !== principal.actorId) deny('Action proposal was not found.', 404, 'PROPOSAL_NOT_FOUND');
  actionDefinition(proposal.actionKey); // protects against a corrupt stored action key
  const posClient = await scopedPosClient(dependencies, principal, signal);
  const policy = await resolvePolicy(dependencies, principal, proposal.actionKey, posClient, signal);
  if (policy.version !== proposal.policyVersion) return policyMismatchTerminal(proposal);
  await consumeConfirmLimit(dependencies, principal, signal);
  if (proposal.actionKey.startsWith('ops.')) {
    const executeOperational = requireDependency(dependencies.operationalExecutor, 'Trusted operational action executor');
    const actionId = randomUUID();
    try {
      const outcome = await executeOperational({
        principal, proposal, actionId,
        confirmationNonceHash: nonceHash(input.confirmationNonce),
        rotatedNonceHash: nonceHash(nextNonce()),
        expectedPolicyVersion: policy.version,
        signal,
      });
      return publicTerminal(outcome?.proposal, outcome);
    } catch {
      const current = await store.getActionProposal(principal, proposal.id, { signal }).catch(() => null);
      const reconciled = current ? await reconcileIfAvailable(dependencies, { principal, proposal: current, posClient, signal }) : null;
      return publicTerminal(reconciled ?? { ...proposal, state: 'reconciliation_pending', terminalCode: 'EXECUTION_AMBIGUOUS' });
    }
  }
  requireDependency(dependencies.executor, 'Trusted POS action executor');

  const leaseId = randomUUID();
  const rotatedNonce = nextNonce();
  let claimed;
  try {
    claimed = await store.claimActionProposal(principal, {
      proposalId: proposal.id,
      confirmationNonceHash: nonceHash(input.confirmationNonce),
      rotatedNonceHash: nonceHash(rotatedNonce),
      leaseId,
      leaseSeconds: 60,
      expectedPolicyVersion: policy.version,
    }, { signal });
  } catch {
    const current = await store.getActionProposal(principal, proposal.id, { signal });
    const reconciled = current ? await reconcileIfAvailable(dependencies, { principal, proposal: current, posClient, signal }) : null;
    return publicTerminal(reconciled ?? proposal);
  }

  const definition = actionDefinition(claimed.actionKey);
  if (!definition.requiresPin && input.managerPin !== undefined) input.managerPin = undefined;
  const actionId = randomUUID();
  let outcome;
  try {
    const capability = capabilityFor({ dependencies, proposal: claimed, principal, actionId });
    outcome = await dependencies.executor({ principal, proposal: claimed, actionId, capability, managerPin: input.managerPin, posClient, signal });
  } catch {
    // A timed-out/ambiguous transport is never treated as a failed POS write. Keep the lease
    // projection pending; a later authenticated status request may query POS audit safely.
    try {
      await store.recordActionTerminal(principal, { proposalId: claimed.id, leaseId, state: 'reconciliation_pending', code: 'EXECUTION_AMBIGUOUS' }, { signal });
    } catch { /* best effort projection only */ }
    return publicTerminal({ ...claimed, state: 'reconciliation_pending', terminalCode: 'EXECUTION_AMBIGUOUS' });
  } finally {
    // PIN must not survive the one executor call or be included in any error/telemetry object.
    input.managerPin = undefined;
  }

  if (!outcome || typeof outcome !== 'object' || !TERMINAL.has(outcome.status)) {
    try { await store.recordActionTerminal(principal, { proposalId: claimed.id, leaseId, state: 'reconciliation_pending', code: 'EXECUTION_AMBIGUOUS' }, { signal }); } catch { /* projection best effort */ }
    return publicTerminal({ ...claimed, state: 'reconciliation_pending', terminalCode: 'EXECUTION_AMBIGUOUS' });
  }
  if (outcome.status === 'succeeded' && (outcome.authoritativePosAudit !== true || !outcome.posAuditActionId)) {
    // A response without authoritative audit identity is ambiguous, even if an adapter calls it
    // "success". Do not project it as success or let the browser infer a completed write.
    try { await store.recordActionTerminal(principal, { proposalId: claimed.id, leaseId, state: 'reconciliation_pending', code: 'EXECUTION_AMBIGUOUS' }, { signal }); } catch { /* projection best effort */ }
    return publicTerminal({ ...claimed, state: 'reconciliation_pending', terminalCode: 'EXECUTION_AMBIGUOUS' });
  }
  if (outcome.status === 'rejected' && outcome.code === 'PIN_REJECTED') {
    const retryNonce = nextNonce();
    if (typeof store.releaseActionProposalAfterRejection !== 'function') deny('Action proposal storage is unavailable.', 503, 'ACTION_DISABLED');
    await store.releaseActionProposalAfterRejection(principal, { proposalId: claimed.id, leaseId, nextConfirmationNonceHash: nonceHash(retryNonce), code: 'PIN_REJECTED' }, { signal });
    return { ...publicTerminal({ ...claimed, state: 'rejected', terminalCode: 'PIN_REJECTED' }), nextConfirmationNonce: retryNonce };
  }
  const recorded = await store.recordActionTerminal(principal, {
    proposalId: claimed.id,
    leaseId,
    state: outcome.status,
    code: requiredString(outcome.code || 'ACTION_RESULT', 'executor result code', 80),
    ...(outcome.message ? { message: requiredString(outcome.message, 'executor result message', 500) } : {}),
    ...(outcome.actionId ? { actionId: uuid(outcome.actionId, 'executor actionId') } : { actionId }),
    ...(outcome.posAuditActionId ? { posAuditActionId: uuid(outcome.posAuditActionId, 'executor POS audit action id') } : {}),
    authoritativePosAudit: outcome.status === 'succeeded' && outcome.authoritativePosAudit === true,
    terminalResult: {
      ...(outcome.result && typeof outcome.result === 'object' ? { result: outcome.result } : {}),
      ...(outcome.undo && typeof outcome.undo === 'object' ? { undo: outcome.undo } : {}),
      completedAt: outcome.completedAt || new Date().toISOString(),
    },
  }, { signal });
  return publicTerminal(recorded, outcome);
}

async function handleStatus({ headers, params, query, dependencies, signal }) {
  const proposalId = uuid(params.proposalId, 'proposalId');
  exactQuery(query, []);
  const { principal } = await authenticateProposalPrincipal(headers, proposalId, dependencies, signal);
  const store = dependencies.proposalStore;
  if (!store || typeof store.getActionProposal !== 'function') deny('Action proposal storage is unavailable.', 503, 'ACTION_DISABLED');
  const proposal = await store.getActionProposal(principal, proposalId, { signal });
  if (!proposal) deny('Action proposal was not found.', 404, 'PROPOSAL_NOT_FOUND');
  const posClient = await scopedPosClient(dependencies, principal, signal);
  const reconciled = await reconcileIfAvailable(dependencies, { principal, proposal, posClient, signal });
  return publicTerminal(reconciled);
}

async function handleHistory({ headers, query, dependencies, signal }) {
  exactQuery(query, ['businessId', 'cursor', 'limit']);
  const businessId = requiredString(query.businessId, 'businessId', 128);
  const principal = await authenticate(headers, businessId, signal);
  const list = requireDependency(dependencies.history, 'Action history service');
  const posClient = await scopedPosClient(dependencies, principal, signal);
  const limit = query.limit == null ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ActionHttpError('limit must be an integer from 1 to 100');
  const result = await list({ principal, posClient, cursor: query.cursor ?? null, limit, signal });
  return { schemaVersion: 1, items: Array.isArray(result?.items) ? result.items : [], ...(result?.nextCursor ? { nextCursor: result.nextCursor } : {}) };
}

async function handleUndo({ headers, body, dependencies, signal }) {
  const input = parseUndo(body);
  const { principal } = await authenticateProposalPrincipal(headers, input.proposalId, dependencies, signal);
  const prepare = requireDependency(dependencies.prepareUndo, 'Undo preparation service');
  const posClient = await scopedPosClient(dependencies, principal, signal);
  // Undo is a fresh proposal. It intentionally has no PIN/capability fields; those can only be
  // accepted by the later confirm call and only reach the narrow POS RPC there.
  const result = await prepare({ principal, proposalId: input.proposalId, posClient, signal });
  return result?.proposal ? { schemaVersion: 1, proposal: result.proposal } : { schemaVersion: 1, proposalId: input.proposalId, status: 'undo_unavailable', code: 'UNDO_UNAVAILABLE' };
}

/** Pure request handler shared by Lambda and the local Node server. */
export async function handleActionHttpRequest(request, { dependencies = createTrustedActionDependencies() } = {}) {
  const method = request?.method?.toUpperCase();
  const path = request?.path;
  try {
    if (method === 'POST' && path === '/copilot/actions/confirm') return { status: 200, body: await handleConfirm({ ...request, dependencies }) };
    if (method === 'POST' && path === '/copilot/actions/undo') return { status: 200, body: await handleUndo({ ...request, dependencies }) };
    if (method === 'GET' && path === '/copilot/actions/history') return { status: 200, body: await handleHistory({ ...request, dependencies }) };
    const match = method === 'GET' && /^\/copilot\/actions\/([0-9a-f-]+)$/.exec(path || '');
    if (match) return { status: 200, body: await handleStatus({ ...request, params: { proposalId: match[1] }, dependencies }) };
    return { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
  } catch (error) {
    const status = error instanceof ActionHttpError ? error.status : error?.status || 500;
    const message = error instanceof ActionHttpError ? error.message : 'Approved action service is unavailable.';
    return { status, body: { error: message, ...(error instanceof ActionHttpError ? { code: error.code } : { code: 'ACTION_UNAVAILABLE' }) } };
  }
}
