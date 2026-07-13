import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatHandlerMock = vi.fn();

vi.mock('../handler.mjs', () => ({ handler: chatHandlerMock }));

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
});
