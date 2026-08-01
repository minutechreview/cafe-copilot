import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 8785 JSON Canonicalization Scheme for values that are already parsed by
 * the server.  Action inputs deliberately do not accept JSON strings, so a
 * duplicate-key JSON parser is not part of this boundary.
 */
export function canonicalizeJcs(value) {
  const seen = new Set();

  function assertUnicodeScalarString(text) {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('JCS strings must not contain lone surrogates');
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error('JCS strings must not contain lone surrogates');
      }
    }
  }

  function encode(item) {
    if (item === null) return 'null';
    if (typeof item === 'string') { assertUnicodeScalarString(item); return JSON.stringify(item); }
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('JCS values must not contain non-finite numbers');
      // JSON.stringify uses the ECMAScript number serialization required by JCS
      // (and canonically changes -0 to 0).
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new Error('JCS values must not contain cycles');
      seen.add(item);
      const encoded = `[${item.map((entry) => {
        if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
          throw new Error('JCS arrays must contain JSON values');
        }
        return encode(entry);
      }).join(',')}]`;
      seen.delete(item);
      return encoded;
    }
    if (typeof item === 'object') {
      if (seen.has(item)) throw new Error('JCS values must not contain cycles');
      seen.add(item);
      const keys = Object.keys(item).sort();
      const pairs = keys.map((key) => {
        assertUnicodeScalarString(key);
        const entry = item[key];
        if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
          throw new Error(`JCS object field ${key} must contain a JSON value`);
        }
        return `${JSON.stringify(key)}:${encode(entry)}`;
      });
      seen.delete(item);
      return `{${pairs.join(',')}}`;
    }
    throw new Error('JCS values must contain JSON values');
  }

  return encode(value);
}

export function canonicalSha256(value) {
  return createHash('sha256').update(canonicalizeJcs(value), 'utf8').digest('hex');
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function decodeBase64url(value, field = 'base64url value') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.includes('=')) {
    throw new Error(`${field} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) {
    throw new Error(`${field} must be canonical unpadded base64url`);
  }
  return decoded;
}

export function hmacSha256Base64url(secret, body) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error('capability signing key must be at least 256 bits');
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

export function constantTimeEqualBase64url(left, right) {
  try {
    const a = decodeBase64url(left, 'signature');
    const b = decodeBase64url(right, 'signature');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
