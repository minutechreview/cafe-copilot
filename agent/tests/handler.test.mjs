import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();
const createConversationMock = vi.fn();
const appendMessageMock = vi.fn();
const getRecentMessagesMock = vi.fn();
const conversationExistsMock = vi.fn();
const executeToolMock = vi.fn();

const FAKE_TOOL_CONFIG = { tools: [{ toolSpec: { name: 'fake_tool' } }] };

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
    ConverseStreamCommand: vi.fn().mockImplementation((input) => ({ input })),
  };
});

vi.mock('../../memory/store.mjs', () => ({
  createConversation: createConversationMock,
  appendMessage: appendMessageMock,
  getRecentMessages: getRecentMessagesMock,
  conversationExists: conversationExistsMock,
}));

vi.mock('../tools.mjs', () => ({
  toolConfig: FAKE_TOOL_CONFIG,
  executeTool: executeToolMock,
}));

/** Wraps a list of ConverseStream-shaped events as the async iterable `response.stream`. */
function streamOf(events) {
  return {
    stream: (async function* () {
      for (const event of events) yield event;
    })(),
  };
}

/**
 * Builds a stream of events for a turn that ends in plain text, optionally split into
 * multiple delta chunks to exercise ordered forwarding.
 */
function textStream(chunks) {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  return streamOf([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    ...list.map((text) => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } })),
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
  ]);
}

/**
 * Builds a stream of events for a turn that calls one tool, with the tool input JSON
 * optionally split across multiple delta chunks (to exercise buffering across chunks) and
 * optional narration text emitted first (to exercise delta-before-tool-call ordering).
 */
function toolUseStream({ toolUseId, name, inputChunks, narration }) {
  const chunks = Array.isArray(inputChunks) ? inputChunks : [inputChunks];
  const events = [];
  let index = 0;
  if (narration) {
    events.push({ contentBlockStart: { contentBlockIndex: index, start: {} } });
    events.push({ contentBlockDelta: { contentBlockIndex: index, delta: { text: narration } } });
    events.push({ contentBlockStop: { contentBlockIndex: index } });
    index += 1;
  }
  events.push({ contentBlockStart: { contentBlockIndex: index, start: { toolUse: { toolUseId, name } } } });
  for (const chunk of chunks) {
    events.push({ contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input: chunk } } } });
  }
  events.push({ contentBlockStop: { contentBlockIndex: index } });
  events.push({ messageStop: { stopReason: 'tool_use' } });
  return streamOf(events);
}

/** Collects every event `handler` emits for a call into an array, for assertions. */
async function runAndCollectEvents(input) {
  const events = [];
  await (await import('../handler.mjs')).handler({ ...input, onEvent: (event) => events.push(event) });
  return events;
}

describe('handler', () => {
  const ORIGINAL_ENV = { ...process.env };
  const EXPECTED_DEFAULT_PRINCIPAL = {
    businessId: 'demo-cafe',
    actorId: 'legacy_demo',
    accessMode: 'legacy_demo',
  };

  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    createConversationMock.mockReset();
    appendMessageMock.mockReset();
    getRecentMessagesMock.mockReset();
    conversationExistsMock.mockReset();
    executeToolMock.mockReset();
    process.env.AWS_REGION = 'us-east-1';
    process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-5-sonnet-test';

    createConversationMock.mockResolvedValue('new-conv-id');
    getRecentMessagesMock.mockResolvedValue([]);
    conversationExistsMock.mockResolvedValue(true);
    appendMessageMock.mockResolvedValue('msg-id');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('bufferedHandler (JSON-compat façade)', () => {
    it('answers directly when the model needs no tools, and persists both sides of the turn', async () => {
      sendMock.mockResolvedValueOnce(textStream('Hello, how can I help your cafe today?'));

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'Say hello', conversationId: 'abc-123' });

      expect(result).toEqual({
        reply: 'Hello, how can I help your cafe today?',
        conversationId: 'abc-123',
      });
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(executeToolMock).not.toHaveBeenCalled();

      const converseInput = sendMock.mock.calls[0][0].input;
      expect(converseInput.toolConfig).toBe(FAKE_TOOL_CONFIG);
      expect(converseInput.inferenceConfig).toEqual({ maxTokens: 700 });
      expect(converseInput.messages).toEqual([{ role: 'user', content: [{ text: 'Say hello' }] }]);

      expect(appendMessageMock).toHaveBeenNthCalledWith(1, EXPECTED_DEFAULT_PRINCIPAL, {
        conversationId: 'abc-123',
        role: 'user',
        content: 'Say hello',
      });
      expect(appendMessageMock).toHaveBeenNthCalledWith(2, EXPECTED_DEFAULT_PRINCIPAL, {
        conversationId: 'abc-123',
        role: 'assistant',
        content: 'Hello, how can I help your cafe today?',
      });
    });

    it('creates a new conversation when none is supplied and returns its id', async () => {
      sendMock.mockResolvedValueOnce(textStream('Hi there!'));

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'Hello' });

      expect(createConversationMock).toHaveBeenCalledWith(EXPECTED_DEFAULT_PRINCIPAL, { title: 'chat conversation' });
      expect(getRecentMessagesMock).not.toHaveBeenCalled();
      expect(result.conversationId).toBe('new-conv-id');
      expect(appendMessageMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['foreign actor'],
      ['foreign business'],
      ['foreign mode'],
      ['stale id'],
    ])('replaces a %s conversation id with a new owned conversation', async () => {
      conversationExistsMock.mockResolvedValueOnce(false);
      sendMock.mockResolvedValueOnce(textStream('Fresh conversation.'));
      const principal = { businessId: 'biz-1', actorId: 'user-1', accessMode: 'authenticated' };
      const { bufferedHandler } = await import('../handler.mjs');

      const result = await bufferedHandler({ message: 'hello', conversationId: 'foreign-id', principal, posClient: {} });

      expect(conversationExistsMock).toHaveBeenCalledWith(principal, 'foreign-id');
      expect(getRecentMessagesMock).not.toHaveBeenCalledWith(principal, 'foreign-id', expect.anything());
      expect(createConversationMock).toHaveBeenCalledWith(principal, { title: 'chat conversation' });
      expect(result.conversationId).toBe('new-conv-id');
      expect(appendMessageMock).toHaveBeenCalledWith(
        principal,
        expect.objectContaining({ conversationId: 'new-conv-id' })
      );
    });

    it('keeps a valid owned conversation even when it has no messages', async () => {
      sendMock.mockResolvedValueOnce(textStream('Owned empty conversation.'));
      const principal = { businessId: 'biz-1', actorId: 'user-1', accessMode: 'authenticated' };
      const { bufferedHandler } = await import('../handler.mjs');

      const result = await bufferedHandler({ message: 'hello', conversationId: 'owned-empty', principal, posClient: {} });

      expect(conversationExistsMock).toHaveBeenCalledWith(principal, 'owned-empty');
      expect(getRecentMessagesMock).toHaveBeenCalledWith(principal, 'owned-empty', 12);
      expect(createConversationMock).not.toHaveBeenCalled();
      expect(result.conversationId).toBe('owned-empty');
    });

    it('passes custom explicit principal when supplied by authenticated caller', async () => {
      sendMock.mockResolvedValueOnce(textStream('Hi authenticated user!'));
      const authPrincipal = { businessId: 'biz-custom', actorId: 'usr-99', accessMode: 'authenticated' };

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'Hello auth', principal: authPrincipal });

      expect(createConversationMock).toHaveBeenCalledWith(authPrincipal, { title: 'chat conversation' });
      expect(result.conversationId).toBe('new-conv-id');
      expect(appendMessageMock).toHaveBeenNthCalledWith(1, authPrincipal, {
        conversationId: 'new-conv-id',
        role: 'user',
        content: 'Hello auth',
      });
    });

    it('rejects a request where top-level businessId disagrees with principal.businessId', async () => {
      const authPrincipal = { businessId: 'biz-A', actorId: 'usr-99', accessMode: 'authenticated' };
      const { bufferedHandler } = await import('../handler.mjs');

      await expect(
        bufferedHandler({ message: 'hi', businessId: 'biz-B', principal: authPrincipal })
      ).rejects.toThrow('businessId mismatch between parameter and principal');

      expect(sendMock).not.toHaveBeenCalled();
      expect(createConversationMock).not.toHaveBeenCalled();
    });

    it('rejects an invalid principal shape', async () => {
      const invalidPrincipal = { businessId: 'biz-A' }; // missing actorId/accessMode
      const { bufferedHandler } = await import('../handler.mjs');

      await expect(
        bufferedHandler({ message: 'hi', principal: invalidPrincipal })
      ).rejects.toThrow('invalid principal shape');

      expect(sendMock).not.toHaveBeenCalled();
    });

    it('rejects a custom businessId parameter when principal is omitted', async () => {
      const { bufferedHandler } = await import('../handler.mjs');

      await expect(
        bufferedHandler({ message: 'hi', businessId: 'custom-other-cafe' })
      ).rejects.toThrow('businessId parameter requires a valid principal object');

      expect(sendMock).not.toHaveBeenCalled();
      expect(createConversationMock).not.toHaveBeenCalled();
    });

    it('runs one tool call then returns the final answer, without persisting the tool round-trip', async () => {
      sendMock
        .mockResolvedValueOnce(
          toolUseStream({ toolUseId: 'call-1', name: 'get_day_summary', inputChunks: '{"date":"2026-07-04"}' })
        )
        .mockResolvedValueOnce(textStream('July 4th did LKR 32,400 in gross sales.'));
      executeToolMock.mockResolvedValueOnce({ kpis: { gross_sales: 32400 } });

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'How was July 4th?', conversationId: 'abc-123' });

      expect(result.reply).toBe('July 4th did LKR 32,400 in gross sales.');
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(executeToolMock).toHaveBeenCalledWith(
        'get_day_summary',
        { date: '2026-07-04' },
        { businessId: 'demo-cafe', conversationId: 'abc-123', principal: EXPECTED_DEFAULT_PRINCIPAL, posClient: undefined }
      );

      const secondInput = sendMock.mock.calls[1][0].input;
      expect(secondInput.messages).toHaveLength(3);
      expect(secondInput.messages[1].content[0].toolUse.name).toBe('get_day_summary');
      expect(secondInput.messages[2]).toEqual({
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'call-1',
              content: [{ json: { kpis: { gross_sales: 32400 } } }],
              status: 'success',
            },
          },
        ],
      });
      expect(secondInput.toolConfig).toBe(FAKE_TOOL_CONFIG);

      expect(appendMessageMock).toHaveBeenCalledTimes(2);
      expect(appendMessageMock).toHaveBeenNthCalledWith(1, EXPECTED_DEFAULT_PRINCIPAL, {
        conversationId: 'abc-123',
        role: 'user',
        content: 'How was July 4th?',
      });
    });

    it('feeds a tool error back to the model as a status: error tool result and still answers', async () => {
      sendMock
        .mockResolvedValueOnce(
          toolUseStream({ toolUseId: 'call-1', name: 'get_day_summary', inputChunks: '{"date":"2026-07-04"}' })
        )
        .mockResolvedValueOnce(textStream('I could not check that day, please try again.'));
      executeToolMock.mockRejectedValueOnce(new Error('POS staging authentication failed'));

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'How was July 4th?' });

      expect(result.reply).toBe('I could not check that day, please try again.');
      const secondInput = sendMock.mock.calls[1][0].input;
      expect(secondInput.messages[2].content[0].toolResult).toEqual({
        toolUseId: 'call-1',
        content: [{ json: { error: 'POS staging authentication failed' } }],
        status: 'error',
      });
    });

    it('captures a draft_purchase_order tool result and returns it alongside the reply', async () => {
      const draftPayload = { id: 'draft-1', kind: 'purchase_order', items: [{ name: 'milk', quantity: 30 }] };
      sendMock
        .mockResolvedValueOnce(
          toolUseStream({
            toolUseId: 'call-1',
            name: 'draft_purchase_order',
            inputChunks: '{"items":[{"name":"milk","quantity":30}]}',
          })
        )
        .mockResolvedValueOnce(textStream('I drafted a purchase order for milk — take a look.'));
      executeToolMock.mockResolvedValueOnce(draftPayload);

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'Draft a PO for 30L milk' });

      expect(result.draft).toEqual(draftPayload);
    });

    it('does not attach a draft when the tool call was not draft_purchase_order', async () => {
      sendMock
        .mockResolvedValueOnce(
          toolUseStream({ toolUseId: 'call-1', name: 'get_day_summary', inputChunks: '{"date":"2026-07-04"}' })
        )
        .mockResolvedValueOnce(textStream('Answer.'));
      executeToolMock.mockResolvedValueOnce({ kpis: {} });

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'How was July 4th?' });

      expect(result.draft).toBeUndefined();
    });

    it('stops asking for tools at the iteration cap by withholding toolConfig on the final call', async () => {
      for (let i = 0; i < 5; i += 1) {
        sendMock.mockResolvedValueOnce(
          toolUseStream({ toolUseId: `call-${i}`, name: 'search_memory', inputChunks: '{"query":"x"}' })
        );
      }
      sendMock.mockResolvedValueOnce(textStream('Best I can tell without more tool calls...'));
      executeToolMock.mockResolvedValue({ results: [] });

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'Tell me everything' });

      expect(sendMock).toHaveBeenCalledTimes(6);
      expect(executeToolMock).toHaveBeenCalledTimes(5);
      expect(result.reply).toBe('Best I can tell without more tool calls...');

      const finalInput = sendMock.mock.calls[5][0].input;
      expect(finalInput.toolConfig).toBeUndefined();
      for (let i = 0; i < 5; i += 1) {
        expect(sendMock.mock.calls[i][0].input.toolConfig).toBe(FAKE_TOOL_CONFIG);
      }
    });

    it('throws a plain-language error if the model still asks for a tool after the cap', async () => {
      for (let i = 0; i < 6; i += 1) {
        sendMock.mockResolvedValueOnce(
          toolUseStream({ toolUseId: `call-${i}`, name: 'search_memory', inputChunks: '{"query":"x"}' })
        );
      }
      executeToolMock.mockResolvedValue({ results: [] });

      const { bufferedHandler } = await import('../handler.mjs');

      await expect(bufferedHandler({ message: 'Tell me everything' })).rejects.toThrow(
        "The copilot couldn't answer just now. Please try again."
      );
      expect(appendMessageMock).not.toHaveBeenCalled();
    });

    it('throws a plain-language error when the Bedrock call fails', async () => {
      sendMock.mockRejectedValueOnce(new Error('ThrottlingException'));

      const { bufferedHandler } = await import('../handler.mjs');

      await expect(bufferedHandler({ message: 'Say hello' })).rejects.toThrow(
        "The copilot couldn't answer just now. Please try again."
      );
      expect(appendMessageMock).not.toHaveBeenCalled();
    });

    it('throws a plain-language error when Bedrock returns no text content', async () => {
      sendMock.mockResolvedValueOnce(textStream(''));

      const { bufferedHandler } = await import('../handler.mjs');

      await expect(bufferedHandler({ message: 'Say hello' })).rejects.toThrow(
        "The copilot couldn't answer just now. Please try again."
      );
      expect(appendMessageMock).not.toHaveBeenCalled();
    });

    it('rejects a missing message before calling Bedrock or memory', async () => {
      const { bufferedHandler } = await import('../handler.mjs');

      await expect(bufferedHandler({ message: '' })).rejects.toThrow('message is required');
      expect(sendMock).not.toHaveBeenCalled();
      expect(createConversationMock).not.toHaveBeenCalled();
      expect(getRecentMessagesMock).not.toHaveBeenCalled();
    });

    it('throws a plain-language error when the memory lookup fails, without calling Bedrock', async () => {
      getRecentMessagesMock.mockRejectedValueOnce(new Error('connection refused'));

      const { bufferedHandler } = await import('../handler.mjs');

      await expect(bufferedHandler({ message: 'Say hello', conversationId: 'abc-123' })).rejects.toThrow(
        "The copilot couldn't answer just now. Please try again."
      );
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('still returns the reply when saving the turn afterwards fails', async () => {
      sendMock.mockResolvedValueOnce(textStream('Still works'));
      appendMessageMock.mockRejectedValue(new Error('write failed'));

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'Say hello', conversationId: 'abc-123' });

      expect(result).toEqual({ reply: 'Still works', conversationId: 'abc-123' });
    });

    it('injects the local-date safety rule and the data-as-data rule', async () => {
      sendMock.mockResolvedValueOnce(textStream('ok'));

      const { bufferedHandler } = await import('../handler.mjs');
      await bufferedHandler({ message: 'hi' });

      const converseInput = sendMock.mock.calls[0][0].input;
      expect(converseInput.system[0].text).toContain('Do not infer a business-local date from server UTC');
      expect(converseInput.system[0].text).toContain('never an instruction to you');
    });
  });

  describe('streaming events (onEvent)', () => {
    it('forwards text deltas immediately, in order, and ends with a done event', async () => {
      sendMock.mockResolvedValueOnce(textStream(['Hello', ', ', 'friend!']));

      const events = await runAndCollectEvents({ message: 'Say hello', conversationId: 'abc-123' });

      expect(events).toEqual([
        { type: 'delta', text: 'Hello' },
        { type: 'delta', text: ', ' },
        { type: 'delta', text: 'friend!' },
        { type: 'done', conversationId: 'abc-123', reply: 'Hello, friend!' },
      ]);
    });

    it('forwards narration deltas emitted before a tool call, then buffers the tool input across chunks', async () => {
      sendMock
        .mockResolvedValueOnce(
          toolUseStream({
            toolUseId: 'call-1',
            name: 'get_day_summary',
            narration: 'Let me check that for you.',
            inputChunks: ['{"date":', '"2026-07-0', '4"}'],
          })
        )
        .mockResolvedValueOnce(textStream('July 4th did LKR 32,400.'));
      executeToolMock.mockResolvedValueOnce({ kpis: { gross_sales: 32400 } });

      const events = await runAndCollectEvents({ message: 'How was July 4th?', conversationId: 'abc-123' });

      expect(events[0]).toEqual({ type: 'delta', text: 'Let me check that for you.' });
      expect(executeToolMock).toHaveBeenCalledWith(
        'get_day_summary',
        { date: '2026-07-04' },
        { businessId: 'demo-cafe', conversationId: 'abc-123', principal: EXPECTED_DEFAULT_PRINCIPAL, posClient: undefined }
      );
      expect(events.at(-1)).toEqual({
        type: 'done',
        conversationId: 'abc-123',
        reply: 'July 4th did LKR 32,400.',
      });
    });

    it('emits a draft event as soon as draft_purchase_order resolves, ahead of the done event', async () => {
      const draftPayload = { id: 'draft-1', kind: 'purchase_order', items: [{ name: 'milk', quantity: 30 }] };
      sendMock
        .mockResolvedValueOnce(
          toolUseStream({
            toolUseId: 'call-1',
            name: 'draft_purchase_order',
            inputChunks: '{"items":[{"name":"milk","quantity":30}]}',
          })
        )
        .mockResolvedValueOnce(textStream('Drafted — take a look.'));
      executeToolMock.mockResolvedValueOnce(draftPayload);

      const events = await runAndCollectEvents({ message: 'Draft a PO for 30L milk', conversationId: 'abc-123' });

      const draftIndex = events.findIndex((e) => e.type === 'draft');
      const doneIndex = events.findIndex((e) => e.type === 'done');
      expect(draftIndex).toBeGreaterThanOrEqual(0);
      expect(draftIndex).toBeLessThan(doneIndex);
      expect(events[draftIndex]).toEqual({ type: 'draft', draft: draftPayload });
    });

    it('stops after MAX_ITERATIONS tool_use turns and reports an error event instead of throwing', async () => {
      for (let i = 0; i < 6; i += 1) {
        sendMock.mockResolvedValueOnce(
          toolUseStream({ toolUseId: `call-${i}`, name: 'search_memory', inputChunks: '{"query":"x"}' })
        );
      }
      executeToolMock.mockResolvedValue({ results: [] });

      const events = await runAndCollectEvents({ message: 'Tell me everything' });

      expect(sendMock).toHaveBeenCalledTimes(6);
      expect(events.at(-1)).toEqual({
        type: 'error',
        message: "The copilot couldn't answer just now. Please try again.",
      });
      expect(events.some((e) => e.type === 'done')).toBe(false);
    });

    it('reports a mid-stream Bedrock failure as an error event without throwing', async () => {
      sendMock.mockResolvedValueOnce(textStream('Partial thought before it dies...'));
      sendMock.mockReset();
      sendMock.mockResolvedValueOnce({
        stream: (async function* () {
          yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Checking' } } };
          throw new Error('stream connection reset');
        })(),
      });

      const events = await runAndCollectEvents({ message: 'How was today?' });

      expect(events[0]).toEqual({ type: 'delta', text: 'Checking' });
      expect(events.at(-1)).toEqual({
        type: 'error',
        message: "The copilot couldn't answer just now. Please try again.",
      });
      expect(appendMessageMock).not.toHaveBeenCalled();
    });

    it('emits an error event (not a throw) when the memory lookup fails', async () => {
      getRecentMessagesMock.mockRejectedValueOnce(new Error('connection refused'));

      const events = await runAndCollectEvents({ message: 'Say hello', conversationId: 'abc-123' });

      expect(events).toEqual([
        { type: 'error', message: "The copilot couldn't answer just now. Please try again." },
      ]);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('still throws synchronously for a missing message, before any event is emitted', async () => {
      const { handler } = await import('../handler.mjs');
      const events = [];

      await expect(handler({ message: '', onEvent: (e) => events.push(e) })).rejects.toThrow(
        'message is required'
      );
      expect(events).toEqual([]);
    });
  });
});

describe('resolveTrustedChatInput transport boundary', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.DEMO_MODE_ENABLED = 'true';
    process.env.DEMO_BUSINESS_ID = 'demo-cafe';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('converts an authenticated auth result into a minimal principal and fresh scoped POS client', async () => {
    const resolveAuth = vi.fn().mockResolvedValue({
      mode: 'authenticated',
      userId: 'user-1',
      businessId: 'biz-1',
      accessToken: 'SECRET_TOKEN_SHOULD_NOT_BE_FORWARDED',
    });
    const createAuthenticatedPosClient = vi.fn().mockReturnValue({ scoped: true });
    const createDemoPosClient = vi.fn();
    const { resolveTrustedChatInput } = await import('../handler.mjs');

    const input = await resolveTrustedChatInput(
      {
        headers: { authorization: 'Bearer SECRET_TOKEN_SHOULD_NOT_BE_FORWARDED' },
        payload: { mode: 'authenticated', message: 'hello', businessId: 'biz-1', conversationId: 'c-1' },
      },
      { resolveAuth, createAuthenticatedPosClient, createDemoPosClient }
    );

    expect(input).toEqual({
      message: 'hello',
      conversationId: 'c-1',
      principal: { businessId: 'biz-1', actorId: 'user-1', accessMode: 'authenticated' },
      posClient: { scoped: true },
    });
    expect(createAuthenticatedPosClient).toHaveBeenCalledWith('SECRET_TOKEN_SHOULD_NOT_BE_FORWARDED');
    expect(createDemoPosClient).not.toHaveBeenCalled();
    expect(input).not.toHaveProperty('accessToken');
  });

  it('preserves an opaque demo session across requests and does not share its actor', async () => {
    const resolveAuth = vi.fn().mockResolvedValue({
      mode: 'demo',
      demoSessionId: 'demo-session-11111111-1111-4111-8111-111111111111',
    });
    const createDemoPosClient = vi.fn().mockResolvedValue({ demo: true });
    const { getDemoSessionIdFromCookie, resolveTrustedChatInput } = await import('../handler.mjs');
    const existingSession = getDemoSessionIdFromCookie(
      'theme=dark; cafe_copilot_demo_session=demo-session-22222222-2222-4222-8222-222222222222'
    );

    const input = await resolveTrustedChatInput(
      { headers: {}, payload: { mode: 'demo', message: 'hello' }, demoSessionId: existingSession },
      { resolveAuth, createDemoPosClient }
    );

    expect(input.principal).toEqual({
      businessId: 'demo-cafe',
      actorId: 'demo-session-22222222-2222-4222-8222-222222222222',
      accessMode: 'demo',
    });
    expect(input.demoSessionId).toBe('demo-session-22222222-2222-4222-8222-222222222222');
  });

  it('does not fall back to demo when authenticated resolution rejects', async () => {
    const authError = new Error('Invalid or expired authentication token.');
    authError.status = 401;
    const resolveAuth = vi.fn().mockRejectedValue(authError);
    const createDemoPosClient = vi.fn();
    const { resolveTrustedChatInput } = await import('../handler.mjs');

    await expect(
      resolveTrustedChatInput(
        { headers: { authorization: 'Bearer bad-token' }, payload: { mode: 'authenticated', message: 'hello', businessId: 'biz-1' } },
        { resolveAuth, createDemoPosClient }
      )
    ).rejects.toMatchObject({ status: 401 });
    expect(createDemoPosClient).not.toHaveBeenCalled();
  });

  it('requires an explicit mode and never infers demo from missing auth or business fields', async () => {
    const resolveAuth = vi.fn().mockResolvedValue({
      mode: 'demo',
      demoSessionId: 'demo-session-33333333-3333-4333-8333-333333333333',
    });
    const { resolveTrustedChatInput } = await import('../handler.mjs');

    await expect(
      resolveTrustedChatInput({ headers: {}, payload: { message: 'hello' } }, { resolveAuth })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/mode/i) });
    expect(resolveAuth).not.toHaveBeenCalled();
  });
});
