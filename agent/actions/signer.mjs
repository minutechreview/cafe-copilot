import { randomUUID } from 'node:crypto';
import { base64url, canonicalizeJcs, constantTimeEqualBase64url, decodeBase64url, hmacSha256Base64url } from './canonical.mjs';

const CLAIM_KEYS = new Set([
  'v', 'kid', 'jti', 'actionId', 'parentActionId', 'proposalId', 'action', 'businessId',
  'actorUserId', 'payloadHash', 'policyVersion', 'issuedAt', 'expiresAt',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;

function capabilityKeyFromEnvironment(env = process.env) {
  const raw = env.COPILOT_CAPABILITY_HMAC_KEY;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('COPILOT_CAPABILITY_HMAC_KEY is not configured');
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : decodeBase64url(raw, 'COPILOT_CAPABILITY_HMAC_KEY');
  if (key.length !== 32) throw new Error('COPILOT_CAPABILITY_HMAC_KEY must be exactly 256 bits');
  return key;
}

function assertUuid(value, name, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${name} must be a canonical UUID`);
}

function assertClaims(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('capability claims must be an object');
  for (const key of Object.keys(claims)) if (!CLAIM_KEYS.has(key)) throw new Error(`unknown capability claim: ${key}`);
  for (const key of CLAIM_KEYS) if (!Object.hasOwn(claims, key)) throw new Error(`missing capability claim: ${key}`);
  if (claims.v !== 1) throw new Error('unsupported capability version');
  if (typeof claims.kid !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(claims.kid)) throw new Error('invalid capability kid');
  assertUuid(claims.jti, 'jti'); assertUuid(claims.actionId, 'actionId'); assertUuid(claims.proposalId, 'proposalId');
  assertUuid(claims.parentActionId, 'parentActionId', true);
  assertUuid(claims.businessId, 'businessId'); assertUuid(claims.actorUserId, 'actorUserId');
  if (typeof claims.action !== 'string' || !/^[a-z][a-z0-9_.]{1,80}$/.test(claims.action)) throw new Error('invalid capability action');
  if (typeof claims.payloadHash !== 'string' || !HASH.test(claims.payloadHash)) throw new Error('invalid capability payloadHash');
  if (!Number.isSafeInteger(claims.policyVersion) || claims.policyVersion < 0) throw new Error('invalid capability policyVersion');
  for (const field of ['issuedAt', 'expiresAt']) {
    if (typeof claims[field] !== 'string' || !Number.isFinite(Date.parse(claims[field])) || !claims[field].endsWith('Z')) {
      throw new Error(`invalid capability ${field}`);
    }
  }
  if (Date.parse(claims.expiresAt) <= Date.parse(claims.issuedAt)) throw new Error('capability expiry must follow issue time');
}

/** Server-only signer. Its return value is for a trusted executor-to-POS request, never SSE/tool output. */
export function signCapability(claims, { env = process.env, key, now = new Date(), maxLifetimeMs = 30_000 } = {}) {
  // SQL's fixed canonical verifier encodes UTC RFC3339 timestamps to whole seconds.
  const second = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const issuedAt = claims?.issuedAt ?? second(now);
  const expiresAt = claims?.expiresAt ?? second(new Date(now.getTime() + maxLifetimeMs));
  const complete = { ...claims, v: 1, kid: claims?.kid ?? env.COPILOT_CAPABILITY_KID, jti: claims?.jti ?? randomUUID(), issuedAt, expiresAt };
  assertClaims(complete);
  if (Date.parse(expiresAt) - Date.parse(issuedAt) > maxLifetimeMs) throw new Error('capability lifetime exceeds 30 seconds');
  const body = base64url(Buffer.from(canonicalizeJcs(complete), 'utf8'));
  const signature = hmacSha256Base64url(key ?? capabilityKeyFromEnvironment(env), body);
  const envelope = `${body}.${signature}`;
  if (Buffer.byteLength(envelope, 'utf8') > 4096) throw new Error('capability envelope exceeds 4 KiB');
  return envelope;
}

// Useful to an executor test; POS remains the authoritative verifier in production.
export function decodeCapabilityClaims(envelope) {
  if (typeof envelope !== 'string' || Buffer.byteLength(envelope, 'utf8') > 4096) throw new Error('invalid capability envelope');
  const [body, signature, extra] = envelope.split('.');
  if (!body || !signature || extra) throw new Error('invalid capability envelope');
  const text = decodeBase64url(body, 'capability body').toString('utf8');
  const claims = JSON.parse(text);
  assertClaims(claims);
  if (canonicalizeJcs(claims) !== text) throw new Error('capability claims are not JCS canonical');
  return claims;
}

export function verifyCapability(envelope, { env = process.env, key, allowedKids, now = new Date() } = {}) {
  const claims = decodeCapabilityClaims(envelope);
  const [body, signature] = envelope.split('.');
  if (allowedKids && !new Set(allowedKids).has(claims.kid)) throw new Error('capability kid is not allowlisted');
  const expected = hmacSha256Base64url(key ?? capabilityKeyFromEnvironment(env), body);
  if (!constantTimeEqualBase64url(signature, expected)) throw new Error('capability signature is invalid');
  if (Date.parse(claims.expiresAt) <= now.getTime()) throw new Error('capability is expired');
  if (Date.parse(claims.issuedAt) > now.getTime() + 5_000) throw new Error('capability issue time is invalid');
  return claims;
}
