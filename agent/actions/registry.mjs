import { canonicalSha256 } from './canonical.mjs';

export const ACTION_SCHEMA_VERSION = 1;
export const PROPOSAL_LIFETIME_MS = 5 * 60_000;
export const CURRENCY_SCALES = Object.freeze({ KWD: 3, LKR: 2, USD: 2 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const INGREDIENT_AVAILABILITY = new Set(['unknown', 'available', 'unavailable']);
const SURFACES = new Set(['menu', 'inventory', 'purchase_orders', 'end_of_day', 'cash', 'reports']);
const REPORTS = new Set(['sales', 'waste', 'staff_performance', 'cash_reconciliation', 'inventory']);
const OPS = new Set(['reminder', 'handover', 'exception_note']);
const OPS_VERBS = new Set(['create', 'complete', 'cancel', 'supersede']);

export class ActionValidationError extends Error {
  constructor(message, code = 'INVALID_ACTION_INPUT') { super(message); this.name = 'ActionValidationError'; this.code = code; }
}

function object(value, name = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActionValidationError(`${name} must be an object`);
  return value;
}
function exact(value, keys, name = 'input') {
  const input = object(value, name);
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new ActionValidationError(`${name} contains unknown field: ${key}`);
  return input;
}
function requiredString(value, name, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < min || value.length > max) throw new ActionValidationError(`${name} must be a trimmed string of ${min}..${max} characters`);
  return value;
}
function uuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ActionValidationError(`${name} must be a canonical UUID`);
  return value;
}
function revision(value, name = 'expectedRevision') {
  if (!Number.isSafeInteger(value) || value < 1) throw new ActionValidationError(`${name} must be a positive integer`);
  return value;
}
function decimal(value, name, { scale = 3, min = '0', max = '1000000.000', positive = false } = {}) {
  if (typeof value !== 'string' || !new RegExp(`^(?:0|[1-9]\\d*)\\.\\d{${scale}}$`).test(value)) {
    throw new ActionValidationError(`${name} must be an exact ${scale}-decimal string`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < Number(min) || numeric > Number(max) || (positive && numeric <= 0)) {
    throw new ActionValidationError(`${name} is outside the permitted range`);
  }
  return value;
}
function quantity(value, name, limits = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value)) {
    throw new ActionValidationError(`${name} must have at most 3 decimal places`);
  }
  const normalized = value.includes('.') ? value.padEnd(value.indexOf('.') + 4, '0') : `${value}.000`;
  return decimal(normalized, name, { scale: 3, ...limits });
}
function money(value, currency, name = 'amount', limits = {}) {
  const scale = CURRENCY_SCALES[currency];
  if (scale == null) throw new ActionValidationError(`Currency ${currency || 'unknown'} is action-disabled`, 'UNSUPPORTED_CURRENCY');
  return decimal(value, name, { scale, max: scale === 3 ? '1000000.000' : '1000000.00', ...limits });
}
function date(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new ActionValidationError(`${name} must be YYYY-MM-DD`);
  return value;
}
function optionalTimestamp(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ActionValidationError(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function commonTarget(input, fields = []) {
  exact(input, ['targetId', 'expectedRevision', ...fields]);
  return { targetId: uuid(input.targetId, 'targetId'), expectedRevision: revision(input.expectedRevision) };
}

function encodeMenuAvailability(input) {
  const base = commonTarget(input, ['available']);
  if (typeof input.available !== 'boolean') throw new ActionValidationError('available must be boolean');
  return { targetKind: 'menu_item', ...base, available: input.available };
}
function encodeMenuPrice(input, context) {
  const base = commonTarget(input, ['price']);
  return { targetKind: 'menu_item', ...base, price: money(input.price, context.currency, 'price'), currency: context.currency };
}
function encodeIngredientAvailability(input) {
  const base = commonTarget(input, ['availability', 'reason', 'recipeImpactHash']);
  if (!INGREDIENT_AVAILABILITY.has(input.availability)) throw new ActionValidationError('availability is invalid');
  const reason = requiredString(input.reason, 'reason', { min: 3, max: 500 });
  if (typeof input.recipeImpactHash !== 'string' || !HASH.test(input.recipeImpactHash)) throw new ActionValidationError('recipeImpactHash must be sha256 hex');
  return { targetKind: 'inventory_item', ...base, availability: input.availability, reason, recipeImpactHash: input.recipeImpactHash };
}
function encodeWaste(input) {
  const base = commonTarget(input, ['quantity', 'reason']);
  return { targetKind: 'menu_item', ...base, targetUnit: 'item', quantity: quantity(input.quantity, 'quantity', { min: '0.001', max: '1000.000', positive: true }), reason: requiredString(input.reason, 'reason', { min: 3, max: 500 }) };
}
function encodeCash(input, context) {
  exact(input, ['targetId', 'expectedOpen', 'direction', 'amount', 'reason']);
  if (!['in', 'out'].includes(input.direction)) throw new ActionValidationError('direction must be in or out');
  if (input.expectedOpen !== true) throw new ActionValidationError('expectedOpen must be true');
  const scale = CURRENCY_SCALES[context.currency];
  return { targetKind: 'till_session', targetId: uuid(input.targetId, 'targetId'), expectedOpen: true, direction: input.direction, amount: money(input.amount, context.currency, 'amount', { min: scale === 3 ? '0.001' : '0.01', max: scale === 3 ? '100000.000' : '100000.00', positive: true }), currency: context.currency, reason: requiredString(input.reason, 'reason', { min: 3, max: 500 }) };
}
function encodeStock(input) {
  const base = commonTarget(input, ['count', 'reason']);
  return { targetKind: 'inventory_item', ...base, count: quantity(input.count, 'count', { min: '0.000', max: '1000000.000' }), reason: requiredString(input.reason, 'reason', { min: 3, max: 500 }) };
}
function encodePoCreate(input) {
  exact(input, ['supplierId', 'lines', 'snapshotHash']);
  if (typeof input.snapshotHash !== 'string' || !HASH.test(input.snapshotHash)) throw new ActionValidationError('snapshotHash must be sha256 hex');
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) throw new ActionValidationError('lines must contain 1..50 entries');
  const lines = input.lines.map((line, index) => {
    exact(line, ['inventoryItemId', 'quantity', 'unit', 'itemRevision'], `lines[${index}]`);
    return { inventoryItemId: uuid(line.inventoryItemId, `lines[${index}].inventoryItemId`), quantity: quantity(line.quantity, `lines[${index}].quantity`, { min: '0.001', max: '100000.000', positive: true }), unit: requiredString(line.unit, `lines[${index}].unit`, { min: 1, max: 40 }), itemRevision: revision(line.itemRevision, `lines[${index}].itemRevision`) };
  });
  if (new Set(lines.map((line) => line.inventoryItemId)).size !== lines.length) throw new ActionValidationError('purchase order lines must not repeat an inventory item');
  lines.sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
  return { supplierId: uuid(input.supplierId, 'supplierId'), lines, snapshotHash: input.snapshotHash };
}
function encodePoCancel(input) { return { targetKind: 'purchase_order', ...commonTarget(input) }; }
function encodeOperational(action, input) {
  const [, type, verb] = /^ops\.(reminder|handover|exception_note)\.(create|complete|cancel|supersede)$/.exec(action) || [];
  if (!OPS.has(type) || !OPS_VERBS.has(verb)) throw new ActionValidationError('unsupported operational action');
  const fields = verb === 'create' ? ['title', 'body', 'targetKind', 'targetId', 'dueAt'] : ['recordId', 'expectedVersion', ...(verb === 'supersede' ? ['title', 'body', 'dueAt'] : [])];
  exact(input, fields);
  if (verb === 'create') return { recordType: type, verb, title: requiredString(input.title, 'title', { min: 1, max: 120 }), body: requiredString(input.body, 'body', { min: 1, max: 2000 }), targetKind: input.targetKind == null ? null : requiredString(input.targetKind, 'targetKind', { min: 1, max: 60 }), targetId: input.targetId == null ? null : uuid(input.targetId, 'targetId'), dueAt: optionalTimestamp(input.dueAt, 'dueAt') };
  const common = { recordType: type, verb, recordId: uuid(input.recordId, 'recordId'), expectedVersion: revision(input.expectedVersion) };
  return verb === 'supersede' ? { ...common, title: requiredString(input.title, 'title', { min: 1, max: 120 }), body: requiredString(input.body, 'body', { min: 1, max: 2000 }), dueAt: optionalTimestamp(input.dueAt, 'dueAt') } : common;
}
function encodeNavigation(input) {
  exact(input, ['surface', 'recordId', 'businessDate']);
  if (!SURFACES.has(input.surface)) throw new ActionValidationError('surface is not allowlisted');
  return { surface: input.surface, recordId: input.recordId == null ? null : uuid(input.recordId, 'recordId'), businessDate: input.businessDate == null ? null : date(input.businessDate, 'businessDate') };
}
function encodeExport(input) {
  exact(input, ['reportKind', 'startDate', 'endDate', 'columns', 'rowLimit', 'filename']);
  if (!REPORTS.has(input.reportKind)) throw new ActionValidationError('reportKind is not allowlisted');
  const startDate = date(input.startDate, 'startDate'); const endDate = date(input.endDate, 'endDate');
  if (startDate > endDate) throw new ActionValidationError('startDate must not be after endDate');
  if (!Array.isArray(input.columns) || input.columns.length === 0 || input.columns.some((column) => typeof column !== 'string')) throw new ActionValidationError('columns must be a server allowlist');
  if (input.rowLimit !== 10_000) throw new ActionValidationError('rowLimit must be 10000');
  if (typeof input.filename !== 'string' || !/^[a-z_]+_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/.test(input.filename)) throw new ActionValidationError('filename is invalid');
  return { reportKind: input.reportKind, businessDateRange: { startDate, endDate }, columns: [...input.columns], rowLimit: 10_000, filename: input.filename };
}

const REGISTRY = {
  'menu.availability.set': { version: 1, requiresPin: false, encode: encodeMenuAvailability, target: 'menu_item', mutation: true },
  'menu.price.set': { version: 1, requiresPin: true, encode: encodeMenuPrice, target: 'menu_item', mutation: true },
  'ingredient.availability.set': { version: 1, requiresPin: true, encode: encodeIngredientAvailability, target: 'inventory_item', mutation: true },
  'waste.record': { version: 1, requiresPin: true, encode: encodeWaste, target: 'menu_item', mutation: true },
  'cash.paid_in_out.record': { version: 1, requiresPin: true, encode: encodeCash, target: 'till_session', mutation: true },
  'stock.count.correct': { version: 1, requiresPin: true, encode: encodeStock, target: 'inventory_item', mutation: true },
  'purchase_order.draft.create': { version: 1, requiresPin: false, encode: encodePoCreate, target: 'purchase_order', mutation: true },
  'purchase_order.draft.cancel': { version: 1, requiresPin: false, encode: encodePoCancel, target: 'purchase_order', mutation: true },
  'navigation.open': { version: 1, requiresPin: false, encode: encodeNavigation, target: null, mutation: false },
  'report.export_handoff': { version: 1, requiresPin: false, encode: encodeExport, target: null, mutation: false },
};
for (const type of OPS) for (const verb of OPS_VERBS) REGISTRY[`ops.${type}.${verb}`] = { version: 1, requiresPin: false, encode: (input) => encodeOperational(`ops.${type}.${verb}`, input), target: 'operational_record', mutation: false };
Object.freeze(REGISTRY);

export const ACTION_REGISTRY = REGISTRY;
export function getActionDefinition(action) { const definition = REGISTRY[action]; if (!definition) throw new ActionValidationError('action is not allowlisted', 'UNKNOWN_ACTION'); return definition; }
const UUID_SCHEMA = { type: 'string', description: 'Canonical UUID of a business record.' };
const STRING_SCHEMA = { type: 'string' };
const MODEL_SCHEMAS = {
  'menu.availability.set': { properties: { targetId: UUID_SCHEMA, available: { type: 'boolean' } }, required: ['targetId', 'available'] },
  'menu.price.set': { properties: { targetId: UUID_SCHEMA, price: { type: 'string', description: 'Exact currency decimal, for example KWD 1.250.' } }, required: ['targetId', 'price'] },
  'ingredient.availability.set': { properties: { targetId: UUID_SCHEMA, availability: { type: 'string', enum: ['unknown', 'available', 'unavailable'] }, reason: STRING_SCHEMA }, required: ['targetId', 'availability', 'reason'] },
  'waste.record': { properties: { targetId: UUID_SCHEMA, quantity: { type: 'string', description: 'Exact positive 3-decimal quantity.' }, reason: STRING_SCHEMA }, required: ['targetId', 'quantity', 'reason'] },
  'cash.paid_in_out.record': { properties: { targetId: UUID_SCHEMA, direction: { type: 'string', enum: ['in', 'out'] }, amount: { type: 'string', description: 'Exact business-currency amount.' }, reason: STRING_SCHEMA }, required: ['targetId', 'direction', 'amount', 'reason'] },
  'stock.count.correct': { properties: { targetId: UUID_SCHEMA, count: { type: 'string', description: 'Exact non-negative 3-decimal count.' }, reason: STRING_SCHEMA }, required: ['targetId', 'count', 'reason'] },
  'purchase_order.draft.create': { properties: { supplierId: UUID_SCHEMA, lines: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, properties: { inventoryItemId: UUID_SCHEMA, quantity: { type: 'string', description: 'Quantity with at most three decimals.' } }, required: ['inventoryItemId', 'quantity'] } } }, required: ['supplierId', 'lines'] },
  'purchase_order.draft.cancel': { properties: { targetId: UUID_SCHEMA }, required: ['targetId'] },
  'navigation.open': { properties: { surface: { type: 'string', enum: [...SURFACES] }, recordId: UUID_SCHEMA, businessDate: { type: 'string', description: 'Business date YYYY-MM-DD.' } }, required: ['surface'] },
  'report.export_handoff': { properties: { reportKind: { type: 'string', enum: [...REPORTS] }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['reportKind', 'startDate', 'endDate'] },
};
for (const type of OPS) for (const verb of OPS_VERBS) {
  const action = `ops.${type}.${verb}`;
  MODEL_SCHEMAS[action] = verb === 'create'
    ? { properties: { title: STRING_SCHEMA, body: STRING_SCHEMA, targetKind: STRING_SCHEMA, targetId: UUID_SCHEMA, dueAt: { type: 'string', description: 'Optional ISO timestamp.' } }, required: ['title', 'body'] }
    : verb === 'supersede'
      ? { properties: { recordId: UUID_SCHEMA, title: STRING_SCHEMA, body: STRING_SCHEMA, dueAt: { type: 'string', description: 'Optional ISO timestamp.' } }, required: ['recordId', 'title', 'body'] }
      : { properties: { recordId: UUID_SCHEMA }, required: ['recordId'] };
}
export function getActionModelInputSchema(action) {
  getActionDefinition(action);
  const schema = MODEL_SCHEMAS[action];
  if (!schema) throw new ActionValidationError('model input schema is not allowlisted', 'UNKNOWN_ACTION');
  return { type: 'object', additionalProperties: false, ...schema };
}
export function validateModelActionInput(action, input) {
  const schema = getActionModelInputSchema(action);
  exact(input, Object.keys(schema.properties));
  for (const field of schema.required ?? []) if (!Object.hasOwn(input, field)) throw new ActionValidationError(`${field} is required`);
  const validateValue = (value, fieldSchema, name) => {
    if (value == null) return;
    if (fieldSchema.type === 'string' && typeof value !== 'string') throw new ActionValidationError(`${name} must be a string`);
    if (fieldSchema.type === 'boolean' && typeof value !== 'boolean') throw new ActionValidationError(`${name} must be boolean`);
    if (fieldSchema.type === 'integer' && !Number.isInteger(value)) throw new ActionValidationError(`${name} must be an integer`);
    if (fieldSchema.enum && !fieldSchema.enum.includes(value)) throw new ActionValidationError(`${name} is not allowlisted`);
    if (fieldSchema.type === 'array') {
      if (!Array.isArray(value) || value.length < (fieldSchema.minItems ?? 0) || value.length > (fieldSchema.maxItems ?? Number.MAX_SAFE_INTEGER)) throw new ActionValidationError(`${name} has an invalid item count`);
      value.forEach((entry, index) => {
        exact(entry, Object.keys(fieldSchema.items.properties), `${name}[${index}]`);
        for (const required of fieldSchema.items.required ?? []) if (!Object.hasOwn(entry, required)) throw new ActionValidationError(`${name}[${index}].${required} is required`);
        for (const [key, childSchema] of Object.entries(fieldSchema.items.properties)) validateValue(entry[key], childSchema, `${name}[${index}].${key}`);
      });
    }
  };
  for (const [field, fieldSchema] of Object.entries(schema.properties)) validateValue(input[field], fieldSchema, field);
  return input;
}
export function encodeActionPayload(action, input, context = {}) {
  const definition = getActionDefinition(action);
  if (!context || typeof context !== 'object' || typeof context.currency !== 'string') throw new ActionValidationError('trusted business currency is required');
  const payload = definition.encode(input, context);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) throw new ActionValidationError('action payload exceeds 16 KiB');
  return Object.freeze(payload);
}
export function hashActionPayload(action, payload) { getActionDefinition(action); return canonicalSha256(payload); }
