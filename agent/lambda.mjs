// AWS Lambda adapter for the Cafe Copilot chat agent. Wraps the existing callback-driven
// `handler` (agent/handler.mjs) with awslambda.streamifyResponse so a Lambda Function URL in
// RESPONSE_STREAM invoke mode can serve the same Server-Sent Events protocol the web client
// already speaks — this file mirrors dev-server.mjs's streaming branch (lazy stream start so
// a synchronous validation error still gets a real status code, same event framing) but talks
// the Lambda response-stream API instead of Node's http module.
//
// awslambda.streamifyResponse and awslambda.HttpResponseStream are globals injected by the
// Lambda Node.js runtime only when the function is invoked in response-streaming mode — they
// do not exist under plain `node` or in the local dev server, which is why dev-server.mjs
// keeps calling handler.mjs directly instead of going through this file, and why this file
// isn't unit-tested by invoking `handler` directly (see tests/lambda.test.mjs for what is
// covered: the pure request/response helpers, with awslambda stubbed).
import {
  handler as chatHandler,
  getDemoSessionIdFromCookie,
  resolveTrustedChatInput,
} from './handler.mjs';

const GENERIC_ERROR = "The copilot couldn't answer just now. Please try again.";
// Keeps the response-stream connection (and any proxy/CDN in front of it) from treating a
// long tool-calling turn as an idle, dead connection — see STATUS-claude.md's C4b note.
const HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_REQUEST_DEADLINE_MS = 50_000;
const MAX_REQUEST_DEADLINE_MS = 54_000;
const DEFAULT_RATE_LIMIT_REQUESTS = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_KEYS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 20_000;
const rateLimitWindows = new Map();

function positiveIntegerEnv(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    const error = new Error('Copilot service configuration is unavailable.');
    error.statusCode = 503;
    throw error;
  }
  return value;
}

export function getTransportBudget() {
  return {
    deadlineMs: positiveIntegerEnv('COPILOT_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_DEADLINE_MS, MAX_REQUEST_DEADLINE_MS),
    rateLimitRequests: positiveIntegerEnv('COPILOT_RATE_LIMIT_MAX_REQUESTS', DEFAULT_RATE_LIMIT_REQUESTS, 1_000),
    rateLimitWindowMs: positiveIntegerEnv('COPILOT_RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS, 3_600_000),
  };
}

function requestIp(event) {
  return event?.requestContext?.http?.sourceIp || event?.requestContext?.identity?.sourceIp || 'unknown';
}

function allowedOrigins() {
  return [process.env.WEB_ORIGIN, ...(process.env.COPILOT_ALLOWED_ORIGINS || '').split(',')]
    .map((origin) => origin?.trim())
    .filter(Boolean);
}

/** CORS does not stop cross-site writes, so cookie-bearing browser requests need an app check. */
export function assertSafeBrowserRequest(event) {
  const headers = event?.headers || {};
  const originEntry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'origin');
  const origin = originEntry?.[1];
  if (origin && !allowedOrigins().includes(origin)) {
    const error = new Error('Origin is not allowed.');
    error.statusCode = 403;
    throw error;
  }

  const contentTypeEntry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type');
  const contentType = contentTypeEntry?.[1];
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error('Content-Type must be application/json.');
    error.statusCode = 400;
    throw error;
  }
}

/** A bounded per-instance IP throttle; deployment config supplies the global ceiling. */
export function enforceRateLimit(event, now = Date.now()) {
  const { rateLimitRequests, rateLimitWindowMs } = getTransportBudget();
  const key = requestIp(event);
  const active = (rateLimitWindows.get(key) || []).filter((timestamp) => now - timestamp < rateLimitWindowMs);
  if (active.length >= rateLimitRequests) {
    const error = new Error('Too many Copilot requests. Please wait a moment and try again.');
    error.statusCode = 429;
    throw error;
  }
  if (!rateLimitWindows.has(key) && rateLimitWindows.size >= MAX_RATE_LIMIT_KEYS) {
    rateLimitWindows.delete(rateLimitWindows.keys().next().value);
  }
  active.push(now);
  rateLimitWindows.set(key, active);
}

export function resetRateLimitsForTests() {
  rateLimitWindows.clear();
}

/** Parses the Function URL event body into {message, conversationId}, throwing a
 * {statusCode: 400} error on malformed JSON so the caller can respond accordingly. */
export function parseRequestPayload(event) {
  let raw = event?.body;
  if (event?.isBase64Encoded && typeof raw === 'string') {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }
  if (!raw) return {};
  const maxBodyBytes = positiveIntegerEnv('COPILOT_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, 100_000);
  if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes) {
    const err = new Error('Request body is too large.');
    err.statusCode = 413;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Request body must be valid JSON');
    err.statusCode = 400;
    throw err;
  }
}

/** Lambda Function URL CORS config (set at deploy time, see scripts/deploy-lambda.mjs) adds
 * Access-Control-Allow-* headers itself, so this handler only needs to set content type. */
function startSseStream(responseStream, demoSessionId) {
  return awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...(demoSessionId
        ? { 'Set-Cookie': `cafe_copilot_demo_session=${demoSessionId}; Path=/; HttpOnly; SameSite=None; Secure` }
        : {}),
    },
  });
}

function respondJsonError(responseStream, statusCode, message) {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
  stream.write(JSON.stringify({ error: message }));
  stream.end();
}

function clientErrorMessage(error, statusCode = error?.statusCode || error?.status) {
  return [400, 401, 403, 413, 429, 504].includes(statusCode) && error?.message ? error.message : GENERIC_ERROR;
}

function createRequestDeadline() {
  const { deadlineMs } = getTransportBudget();
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('The Copilot request took too long. Please try again.');
      error.statusCode = 504;
      reject(error);
    }, deadlineMs);
  });
  return {
    signal: controller.signal,
    race: (operation) => Promise.race([operation, timedOut]),
    clear: () => clearTimeout(timer),
  };
}

function writeSseEvent(stream, event) {
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  try {
    assertSafeBrowserRequest(event);
  } catch (err) {
    respondJsonError(responseStream, err.statusCode || 400, clientErrorMessage(err, err.statusCode || 400));
    return;
  }

  let payload;
  try {
    payload = parseRequestPayload(event);
  } catch (err) {
    respondJsonError(responseStream, err.statusCode ?? 400, err.message);
    return;
  }

  let input;
  const deadline = createRequestDeadline();
  try {
    enforceRateLimit(event);
    input = await deadline.race(
      resolveTrustedChatInput({
        headers: event?.headers || {},
        payload,
        demoSessionId: getDemoSessionIdFromCookie(event?.headers?.cookie || event?.headers?.Cookie),
        signal: deadline.signal,
      })
    );
  } catch (err) {
    deadline.clear();
    const statusCode = err?.statusCode || err?.status || 500;
    respondJsonError(responseStream, statusCode, clientErrorMessage(err, statusCode));
    return;
  }

  // Headers aren't written (and the stream isn't opened) until the first event arrives, so a
  // synchronous validation failure inside chatHandler (missing message, model not configured)
  // still surfaces as a plain 400/500 JSON response instead of an empty SSE stream — same
  // contract as dev-server.mjs's handleStreamingRequest.
  let sse;
  let heartbeat;

  function ensureStreamStarted() {
    if (!sse) {
      sse = startSseStream(responseStream, input.demoSessionId);
      heartbeat = setInterval(() => sse.write(': ping\n\n'), HEARTBEAT_INTERVAL_MS);
    }
    return sse;
  }

  function writeEvent(evt) {
    writeSseEvent(ensureStreamStarted(), evt);
  }

  try {
    await deadline.race(chatHandler({ ...input, onEvent: writeEvent, signal: deadline.signal }));
    if (sse) {
      clearInterval(heartbeat);
      sse.end();
    } else {
      // handler resolved without ever emitting an event — shouldn't happen, but don't hang
      // the client waiting for bytes that are never coming.
      respondJsonError(responseStream, 500, GENERIC_ERROR);
    }
  } catch (err) {
    console.error('[lambda] /chat request failed', { statusCode: err?.statusCode || err?.status || 500 });
    if (sse) {
      writeEvent({ type: 'error', message: GENERIC_ERROR });
      clearInterval(heartbeat);
      sse.end();
    } else {
      const statusCode = err?.statusCode || err?.status || 500;
      respondJsonError(responseStream, statusCode, clientErrorMessage(err, statusCode));
    }
  } finally {
    deadline.clear();
  }
});
