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

const { handler, bufferedHandler } = await import('./handler.mjs');

const PORT = Number(process.env.PORT) || 8787;
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5173';
const GENERIC_ERROR = "The copilot couldn't answer just now. Please try again.";

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
    const result = await bufferedHandler(input);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const statusCode = err?.statusCode === 400 ? 400 : 500;
    console.error('[dev-server] /chat request failed', err?.message ?? err);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: statusCode === 400 ? err.message : GENERIC_ERROR }));
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
      });
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  try {
    await handler({ ...input, onEvent: writeEvent });
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
    console.error('[dev-server] /chat request failed', err?.message ?? err);
    if (streamStarted) {
      writeEvent({ type: 'error', message: GENERIC_ERROR });
      res.end();
    } else {
      const statusCode = err?.statusCode === 400 ? 400 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: statusCode === 400 ? err.message : GENERIC_ERROR }));
    }
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', WEB_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

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

  const input = { message: payload.message, conversationId: payload.conversationId };

  if (wantsBufferedJson(req)) {
    await handleJsonRequest(req, res, input);
  } else {
    await handleStreamingRequest(req, res, input);
  }
});

server.listen(PORT, () => {
  console.log(`[agent] dev server listening on http://localhost:${PORT}`);
});
