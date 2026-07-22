import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();
const createConversationMock = vi.fn();
const appendMessageMock = vi.fn();
const getRecentMessagesMock = vi.fn();
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
}));

vi.mock('../tools.mjs', () => ({
  toolConfig: FAKE_TOOL_CONFIG,
  executeTool: executeToolMock,
}));

function streamOf(events) {
  return {
    stream: (async function* () {
      for (const event of events) yield event;
    })(),
  };
}

function textStream(chunks) {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  return streamOf([
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    ...list.map((text) => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } })),
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
  ]);
}

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
    executeToolMock.mockReset();
    process.env.AWS_REGION = 'us-east-1';
    process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-5-sonnet-test';

    createConversationMock.mockResolvedValue('new-conv-id');
    getRecentMessagesMock.mockResolvedValue([]);
    appendMessageMock.mockResolvedValue('msg-id');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('bufferedHandler (JSON-compat façade)', () => {
    it('answers directly when the model needs no tools, and persists both sides of the turn with principal', async () => {
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

      expect(appendMessageMock).toHaveBeenNthCalledWith(
        1,
        EXPECTED_DEFAULT_PRINCIPAL,
        {
          conversationId: 'abc-123',
          role: 'user',
          content: 'Say hello',
        }
      );
      expect(appendMessageMock).toHaveBeenNthCalledWith(
        2,
        EXPECTED_DEFAULT_PRINCIPAL,
        {
          conversationId: 'abc-123',
          role: 'assistant',
          content: 'Hello, how can I help your cafe today?',
        }
      );
    });

    it('creates a new conversation with principal when none is supplied and returns its id', async () => {
      sendMock.mockResolvedValueOnce(textStream('Hi there!'));

      const { bufferedHandler } = await import('../handler.mjs');
      const result = await bufferedHandler({ message: 'Hello' });

      expect(createConversationMock).toHaveBeenCalledWith(EXPECTED_DEFAULT_PRINCIPAL, { title: 'chat conversation' });
      expect(getRecentMessagesMock).not.toHaveBeenCalled();
      expect(result.conversationId).toBe('new-conv-id');
      expect(appendMessageMock).toHaveBeenCalledTimes(2);
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

    it('runs one tool call then returns the final answer, passing ctx.principal to executeTool', async () => {
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
        {
          businessId: 'demo-cafe',
          conversationId: 'abc-123',
          principal: EXPECTED_DEFAULT_PRINCIPAL,
          posClient: undefined,
        }
      );

      expect(appendMessageMock).toHaveBeenCalledTimes(2);
      expect(appendMessageMock).toHaveBeenNthCalledWith(1, EXPECTED_DEFAULT_PRINCIPAL, {
        conversationId: 'abc-123',
        role: 'user',
        content: 'How was July 4th?',
      });
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
  });
});
