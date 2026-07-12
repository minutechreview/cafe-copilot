// Minimal local dev wrapper around handler.mjs: exposes POST /chat over plain Node http,
// with CORS for the Vite dev origin. Not used in the Lambda deployment — that will call
// handler.mjs directly through its own adapter.
import { config as loadEnv } from 'dotenv';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

loadEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local') });

const { handler } = await import('./handler.mjs');

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

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', WEB_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  try {
    const result = await handler({
      message: payload.message,
      conversationId: payload.conversationId,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const statusCode = err?.statusCode === 400 ? 400 : 500;
    console.error('[dev-server] /chat request failed', err?.message ?? err);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: statusCode === 400 ? err.message : GENERIC_ERROR }));
  }
});

server.listen(PORT, () => {
  console.log(`[agent] dev server listening on http://localhost:${PORT}`);
});
