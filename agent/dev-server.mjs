// Minimal local dev wrapper around handler.mjs: exposes POST /chat over plain Node http,
// with CORS for the Vite dev origin. Not used in the Lambda deployment — that will call
// handler.mjs directly through its own adapter (Lambda response streaming, C6), reusing the
// same callback-driven `handler` this file already drives via onEvent.
//
// Two response modes on the same route:
//   - Default: Server-Sent Events. Each event from handler.mjs's onEvent is written as one
//     `data: <json>\n\n` line, flushed immediately. Headers aren't written until the first
//     event arrives, so a synchronous validation failure (missing message, bad JSON body)
//     still gets a normal 400/500 JSON response instead of an empty SSE stream.
//   - `Accept: application/json`: the old buffered JSON response, via bufferedHandler — kept
//     for compat and for easy curl testing without an SSE-aware client.
import { config as loadEnv } from 'dotenv';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

loadEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local') });

const { handler, getDemoSessionIdFromCookie, resolveTrustedChatInput } = await import('./handler.mjs');

const PORT = Number(process.env.PORT) || 8787;
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5173';
const GENERIC_ERROR = "The copilot couldn't answer just now. Please try again.";
const DEFAULT_REQUEST_DEADLINE_MS = 50_000;
const MAX_REQUEST_DEADLINE_MS = 54_000;
const MAX_RATE_LIMIT_KEYS = 10_000;
const requestWindows = new Map();

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

function transportBudget() {
  return {
    deadlineMs: positiveIntegerEnv('COPILOT_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_DEADLINE_MS, MAX_REQUEST_DEADLINE_MS),
    requests: positiveIntegerEnv('COPILOT_RATE_LIMIT_MAX_REQUESTS', 20, 1_000),
    windowMs: positiveIntegerEnv('COPILOT_RATE_LIMIT_WINDOW_MS', 60_000, 3_600_000),
  };
}

function enforceRateLimit(req, now = Date.now()) {
  const { requests, windowMs } = transportBudget();
  const key = req.socket.remoteAddress || 'unknown';
  const active = (requestWindows.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (active.length >= requests) {
    const error = new Error('Too many Copilot requests. Please wait a moment and try again.');
    error.statusCode = 429;
    throw error;
  }
  if (!requestWindows.has(key) && requestWindows.size >= MAX_RATE_LIMIT_KEYS) {
    requestWindows.delete(requestWindows.keys().next().value);
  }
  active.push(now);
  requestWindows.set(key, active);
}

function allowedOrigins() {
  return (process.env.COPILOT_ALLOWED_ORIGINS || WEB_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins().includes(origin)) return false;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  return true;
}

function clientErrorMessage(error, statusCode = error?.statusCode || error?.status) {
  return [400, 401, 403, 429, 504].includes(statusCode) && error?.message ? error.message : GENERIC_ERROR;
}

async function runWithDeadline(input, onEvent) {
  const { deadlineMs } = transportBudget();
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
  try {
    return await Promise.race([handler({ ...input, onEvent, signal: controller.signal }), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Buffered JSON compatibility mode uses the same deadline and trusted input as SSE. */
async function runBufferedWithDeadline(input) {
  let draft;
  let done;
  let failure;
  await runWithDeadline(input, (event) => {
    if (event.type === 'draft') draft = event.draft;
    if (event.type === 'done') done = { reply: event.reply, conversationId: event.conversationId };
    if (event.type === 'error') failure = event.message;
  });
  if (failure || !done) throw new Error(failure || GENERIC_ERROR);
  return { ...done, ...(draft ? { draft } : {}) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** True only when the client explicitly asks for the buffered JSON compat response. */
function wantsBufferedJson(req) {
  const accept = req.headers.accept || '';
  return accept.includes('application/json') && !accept.includes('text/event-stream');
}

async function handleJsonRequest(req, res, input) {
  try {
    const result = await runBufferedWithDeadline(input);
    if (input.demoSessionId) {
      res.setHeader('Set-Cookie', `cafe_copilot_demo_session=${input.demoSessionId}; Path=/; HttpOnly; SameSite=Lax`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const statusCode = err?.statusCode || err?.status || 500;
    console.error('[dev-server] /chat request failed', { statusCode });
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: clientErrorMessage(err, statusCode) }));
  }
}

async function handleStreamingRequest(req, res, input) {
  let streamStarted = false;

  function writeEvent(event) {
    if (!streamStarted) {
      streamStarted = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(input.demoSessionId
          ? { 'Set-Cookie': `cafe_copilot_demo_session=${input.demoSessionId}; Path=/; HttpOnly; SameSite=Lax` }
          : {}),
      });
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  try {
    await runWithDeadline(input, writeEvent);
    if (streamStarted) {
      res.end();
    } else {
      // handler resolved without ever emitting an event — shouldn't happen, but don't hang
      // the client waiting for bytes that are never coming.
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: GENERIC_ERROR }));
    }
  } catch (err) {
    // Only the synchronous input/config validation in handler.mjs throws instead of emitting
    // an event, and that always happens before any onEvent call — so if we get here with the
    // stream already started, something else went wrong; report it as best we can either way.
    console.error('[dev-server] /chat request failed', { statusCode: err?.statusCode || err?.status || 500 });
    if (streamStarted) {
      writeEvent({ type: 'error', message: GENERIC_ERROR });
      res.end();
    } else {
      const statusCode = err?.statusCode || err?.status || 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: clientErrorMessage(err, statusCode) }));
    }
  }
}

const server = createServer(async (req, res) => {
  if (!applyCors(req, res)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin is not allowed.' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/chat') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request body must be valid JSON' }));
    return;
  }

  let input;
  try {
    enforceRateLimit(req);
    input = await resolveTrustedChatInput({
      headers: req.headers,
      payload,
      demoSessionId: getDemoSessionIdFromCookie(req.headers.cookie),
    });
  } catch (err) {
    const statusCode = err?.statusCode || err?.status || 500;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: clientErrorMessage(err, statusCode) }));
    return;
  }

  if (wantsBufferedJson(req)) {
    await handleJsonRequest(req, res, input);
  } else {
    await handleStreamingRequest(req, res, input);
  }
});

server.listen(PORT, () => {
  console.log(`[agent] dev server listening on http://localhost:${PORT}`);
});
