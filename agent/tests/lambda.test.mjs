import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatHandlerMock = vi.fn();
const resolveTrustedChatInputMock = vi.fn();
const getDemoSessionIdFromCookieMock = vi.fn();

vi.mock('../handler.mjs', () => ({
  handler: chatHandlerMock,
  resolveTrustedChatInput: resolveTrustedChatInputMock,
  getDemoSessionIdFromCookie: getDemoSessionIdFromCookieMock,
}));

/** Minimal fake of a Lambda response-stream object: records every write() call and whether
 * end() was called, so tests can assert on the SSE bytes without a real Lambda runtime. */
function fakeResponseStream() {
  return { chunks: [], ended: false, write(chunk) { this.chunks.push(chunk); }, end() { this.ended = true; } };
}

/** Stubs the two `awslambda` globals the Lambda Node runtime injects in response-streaming
 * mode: streamifyResponse (just runs the wrapped function immediately, capturing statusCode/
 * headers via HttpResponseStream.from) and HttpResponseStream.from itself. */
function installAwsLambdaGlobal() {
  globalThis.awslambda = {
    streamifyResponse: (fn) => fn,
    HttpResponseStream: {
      from: (responseStream, metadata) => {
        responseStream.statusCode = metadata.statusCode;
        responseStream.headers = metadata.headers;
        return responseStream;
      },
    },
  };
}

beforeEach(() => {
  chatHandlerMock.mockReset();
  resolveTrustedChatInputMock.mockReset();
  getDemoSessionIdFromCookieMock.mockReset();
  resolveTrustedChatInputMock.mockResolvedValue({
    message: 'hi',
    principal: { businessId: 'demo-cafe', actorId: 'demo-session-00000000-0000-4000-8000-000000000000', accessMode: 'demo' },
    posClient: { demo: true },
  });
  getDemoSessionIdFromCookieMock.mockReturnValue(null);
  delete process.env.COPILOT_RATE_LIMIT_MAX_REQUESTS;
  delete process.env.COPILOT_RATE_LIMIT_WINDOW_MS;
  delete process.env.COPILOT_REQUEST_TIMEOUT_MS;
  delete process.env.WEB_ORIGIN;
  installAwsLambdaGlobal();
});

function textOf(stream) {
  return stream.chunks.join('');
}

describe('agent/lambda.mjs', () => {
  it('parseRequestPayload returns {} for an empty body', async () => {
    const { parseRequestPayload } = await import('../lambda.mjs');
    expect(parseRequestPayload({})).toEqual({});
    expect(parseRequestPayload({ body: null })).toEqual({});
  });

  it('parseRequestPayload parses a plain JSON body', async () => {
    const { parseRequestPayload } = await import('../lambda.mjs');
    expect(parseRequestPayload({ body: JSON.stringify({ message: 'hi' }) })).toEqual({ message: 'hi' });
  });

  it('parseRequestPayload decodes a base64-encoded body', async () => {
    const { parseRequestPayload } = await import('../lambda.mjs');
    const body = Buffer.from(JSON.stringify({ message: 'hi' })).toString('base64');
    expect(parseRequestPayload({ body, isBase64Encoded: true })).toEqual({ message: 'hi' });
  });

  it('parseRequestPayload throws a 400 on malformed JSON', async () => {
    const { parseRequestPayload } = await import('../lambda.mjs');
    expect(() => parseRequestPayload({ body: '{not json' })).toThrow(/valid JSON/);
    try {
      parseRequestPayload({ body: '{not json' });
    } catch (err) {
      expect(err.statusCode).toBe(400);
    }
  });

  it('streams delta/done events as SSE with a 200 text/event-stream response', async () => {
    chatHandlerMock.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'delta', text: 'Hey' });
      onEvent({ type: 'done', conversationId: 'c1', reply: 'Hey there' });
    });

    const { handler } = await import('../lambda.mjs');
    const responseStream = fakeResponseStream();
    await handler({ body: JSON.stringify({ message: 'hi' }) }, responseStream);

    expect(responseStream.statusCode).toBe(200);
    expect(responseStream.headers['Content-Type']).toBe('text/event-stream');
    expect(textOf(responseStream)).toContain('data: {"type":"delta","text":"Hey"}\n\n');
    expect(textOf(responseStream)).toContain('data: {"type":"done","conversationId":"c1","reply":"Hey there"}\n\n');
    expect(responseStream.ended).toBe(true);
  });

  it('responds with a plain 400 JSON body for malformed request JSON, no SSE stream opened', async () => {
    const { handler } = await import('../lambda.mjs');
    const responseStream = fakeResponseStream();
    await handler({ body: '{not json' }, responseStream);

    expect(responseStream.statusCode).toBe(400);
    expect(responseStream.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(textOf(responseStream))).toEqual({ error: 'Request body must be valid JSON' });
    expect(chatHandlerMock).not.toHaveBeenCalled();
  });

  it('emits a generic error SSE event if chatHandler throws after streaming started', async () => {
    chatHandlerMock.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'delta', text: 'partial' });
      throw new Error('boom');
    });

    const { handler } = await import('../lambda.mjs');
    const responseStream = fakeResponseStream();
    await handler({ body: JSON.stringify({ message: 'hi' }) }, responseStream);

    expect(responseStream.statusCode).toBe(200);
    expect(textOf(responseStream)).toContain(
      'data: {"type":"error","message":"The copilot couldn\'t answer just now. Please try again."}\n\n'
    );
    expect(responseStream.ended).toBe(true);
  });

  it('responds with a plain 500 JSON body if chatHandler throws before any event', async () => {
    chatHandlerMock.mockImplementation(async () => {
      throw new Error('config missing');
    });

    const { handler } = await import('../lambda.mjs');
    const responseStream = fakeResponseStream();
    await handler({ body: JSON.stringify({ message: 'hi' }) }, responseStream);

    expect(responseStream.statusCode).toBe(500);
    expect(responseStream.headers['Content-Type']).toBe('application/json');
  });

  it('resolves authentication before SSE and passes only a trusted principal and scoped client to chat', async () => {
    const trustedInput = {
      message: 'How was today?',
      conversationId: 'conversation-1',
      principal: { businessId: 'biz-1', actorId: 'user-1', accessMode: 'authenticated' },
      posClient: { scoped: true },
    };
    resolveTrustedChatInputMock.mockResolvedValueOnce(trustedInput);
    chatHandlerMock.mockImplementation(async ({ onEvent }) => onEvent({ type: 'done', conversationId: 'conversation-1', reply: 'Done' }));

    const { handler } = await import('../lambda.mjs');
    const responseStream = fakeResponseStream();
    await handler(
      {
        headers: { Authorization: 'Bearer SECRET_TOKEN_MUST_NOT_REACH_CHAT' },
        body: JSON.stringify({ mode: 'authenticated', message: 'How was today?', businessId: 'biz-1' }),
      },
      responseStream
    );

    expect(resolveTrustedChatInputMock).toHaveBeenCalledWith({
      headers: { Authorization: 'Bearer SECRET_TOKEN_MUST_NOT_REACH_CHAT' },
      payload: { mode: 'authenticated', message: 'How was today?', businessId: 'biz-1' },
      demoSessionId: null,
    });
    expect(chatHandlerMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'How was today?',
      conversationId: 'conversation-1',
      principal: trustedInput.principal,
      posClient: trustedInput.posClient,
    }));
    expect(chatHandlerMock.mock.calls[0][0]).not.toHaveProperty('accessToken');
    expect(responseStream.statusCode).toBe(200);
  });

  it('returns an owner-friendly pre-stream auth denial and never invokes chat', async () => {
    const authError = new Error('Invalid or expired authentication token.');
    authError.status = 401;
    resolveTrustedChatInputMock.mockRejectedValueOnce(authError);

    const { handler } = await import('../lambda.mjs');
    const responseStream = fakeResponseStream();
    await handler({ body: JSON.stringify({ mode: 'authenticated', message: 'hi', businessId: 'biz-1' }) }, responseStream);

    expect(responseStream.statusCode).toBe(401);
    expect(responseStream.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(textOf(responseStream))).toEqual({ error: 'Invalid or expired authentication token.' });
    expect(chatHandlerMock).not.toHaveBeenCalled();
  });

  it('throttles before authentication or streaming when an IP exceeds the configured request ceiling', async () => {
    process.env.COPILOT_RATE_LIMIT_MAX_REQUESTS = '1';
    process.env.COPILOT_RATE_LIMIT_WINDOW_MS = '60000';
    const { handler, resetRateLimitsForTests } = await import('../lambda.mjs');
    resetRateLimitsForTests();
    const event = {
      requestContext: { http: { sourceIp: '203.0.113.7' } },
      body: JSON.stringify({ mode: 'demo', message: 'hi' }),
    };
    chatHandlerMock.mockImplementation(async ({ onEvent }) => onEvent({ type: 'done', conversationId: 'c1', reply: 'Done' }));

    await handler(event, fakeResponseStream());
    const blocked = fakeResponseStream();
    await handler(event, blocked);

    expect(blocked.statusCode).toBe(429);
    expect(JSON.parse(textOf(blocked))).toEqual({ error: 'Too many Copilot requests. Please wait a moment and try again.' });
    expect(resolveTrustedChatInputMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a cross-site browser request before authentication or streaming', async () => {
    process.env.WEB_ORIGIN = 'https://cafe-copilot.pages.dev';
    const { handler } = await import('../lambda.mjs');
    const responseStream = fakeResponseStream();
    await handler(
      {
        headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'demo', message: 'hi' }),
      },
      responseStream
    );

    expect(responseStream.statusCode).toBe(403);
    expect(JSON.parse(textOf(responseStream))).toEqual({ error: 'Origin is not allowed.' });
    expect(resolveTrustedChatInputMock).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON request before authentication or streaming', async () => {
    const { handler } = await import('../lambda.mjs');
    const responseStream = fakeResponseStream();
    await handler(
      {
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ mode: 'demo', message: 'hi' }),
      },
      responseStream
    );

    expect(responseStream.statusCode).toBe(400);
    expect(JSON.parse(textOf(responseStream))).toEqual({ error: 'Content-Type must be application/json.' });
    expect(resolveTrustedChatInputMock).not.toHaveBeenCalled();
  });
});
