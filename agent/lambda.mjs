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
import { handler as chatHandler } from './handler.mjs';

const GENERIC_ERROR = "The copilot couldn't answer just now. Please try again.";
// Keeps the response-stream connection (and any proxy/CDN in front of it) from treating a
// long tool-calling turn as an idle, dead connection — see STATUS-claude.md's C4b note.
const HEARTBEAT_INTERVAL_MS = 15000;

/** Parses the Function URL event body into {message, conversationId}, throwing a
 * {statusCode: 400} error on malformed JSON so the caller can respond accordingly. */
export function parseRequestPayload(event) {
  let raw = event?.body;
  if (event?.isBase64Encoded && typeof raw === 'string') {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }
  if (!raw) return {};
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
function startSseStream(responseStream) {
  return awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
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

function writeSseEvent(stream, event) {
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  let payload;
  try {
    payload = parseRequestPayload(event);
  } catch (err) {
    respondJsonError(responseStream, err.statusCode ?? 400, err.message);
    return;
  }

  const input = { message: payload.message, conversationId: payload.conversationId };

  // Headers aren't written (and the stream isn't opened) until the first event arrives, so a
  // synchronous validation failure inside chatHandler (missing message, model not configured)
  // still surfaces as a plain 400/500 JSON response instead of an empty SSE stream — same
  // contract as dev-server.mjs's handleStreamingRequest.
  let sse;
  let heartbeat;

  function ensureStreamStarted() {
    if (!sse) {
      sse = startSseStream(responseStream);
      heartbeat = setInterval(() => sse.write(': ping\n\n'), HEARTBEAT_INTERVAL_MS);
    }
    return sse;
  }

  function writeEvent(evt) {
    writeSseEvent(ensureStreamStarted(), evt);
  }

  try {
    await chatHandler({ ...input, onEvent: writeEvent });
    if (sse) {
      clearInterval(heartbeat);
      sse.end();
    } else {
      // handler resolved without ever emitting an event — shouldn't happen, but don't hang
      // the client waiting for bytes that are never coming.
      respondJsonError(responseStream, 500, GENERIC_ERROR);
    }
  } catch (err) {
    console.error('[lambda] /chat request failed', err?.message ?? err);
    if (sse) {
      writeEvent({ type: 'error', message: GENERIC_ERROR });
      clearInterval(heartbeat);
      sse.end();
    } else {
      const statusCode = err?.statusCode === 400 ? 400 : 500;
      respondJsonError(responseStream, statusCode, statusCode === 400 ? err.message : GENERIC_ERROR);
    }
  }
});
