import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();
const createConversationMock = vi.fn();
const appendMessageMock = vi.fn();
const getRecentMessagesMock = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
    ConverseCommand: vi.fn().mockImplementation((input) => ({ input })),
  };
});

vi.mock('../../memory/store.mjs', () => ({
  createConversation: createConversationMock,
  appendMessage: appendMessageMock,
  getRecentMessages: getRecentMessagesMock,
}));

describe('handler', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    createConversationMock.mockReset();
    appendMessageMock.mockReset();
    getRecentMessagesMock.mockReset();
    process.env.AWS_REGION = 'us-east-1';
    process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-5-sonnet-test';

    // Sensible defaults so tests that don't care about memory behaviour still work.
    createConversationMock.mockResolvedValue('new-conv-id');
    getRecentMessagesMock.mockResolvedValue([]);
    appendMessageMock.mockResolvedValue('msg-id');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('extracts the reply text from a successful Converse response and persists both sides of the turn', async () => {
    getRecentMessagesMock.mockResolvedValueOnce([
      { role: 'user', content: 'earlier question', createdAt: new Date() },
    ]);
    sendMock.mockResolvedValueOnce({
      output: {
        message: {
          content: [{ text: 'Hello, ' }, { text: 'how can I help your cafe today?' }],
        },
      },
    });

    const { handler } = await import('../handler.mjs');
    const result = await handler({ message: 'Say hello', conversationId: 'abc-123' });

    expect(result).toEqual({
      reply: 'Hello, how can I help your cafe today?',
      conversationId: 'abc-123',
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // History is loaded because a conversationId was supplied, and a new conversation is
    // not created.
    expect(getRecentMessagesMock).toHaveBeenCalledWith('abc-123', 12);
    expect(createConversationMock).not.toHaveBeenCalled();

    // Prior history plus the new user turn is sent to Bedrock.
    const converseInput = sendMock.mock.calls[0][0].input;
    expect(converseInput.messages).toEqual([
      { role: 'user', content: [{ text: 'earlier question' }] },
      { role: 'user', content: [{ text: 'Say hello' }] },
    ]);

    // Both sides of the turn are saved.
    expect(appendMessageMock).toHaveBeenNthCalledWith(1, {
      conversationId: 'abc-123',
      role: 'user',
      content: 'Say hello',
    });
    expect(appendMessageMock).toHaveBeenNthCalledWith(2, {
      conversationId: 'abc-123',
      role: 'assistant',
      content: 'Hello, how can I help your cafe today?',
    });
  });

  it('creates a new conversation when none is supplied and returns its id', async () => {
    sendMock.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'Hi there!' }] } },
    });

    const { handler } = await import('../handler.mjs');
    const result = await handler({ message: 'Hello' });

    expect(createConversationMock).toHaveBeenCalledWith({ businessId: 'demo-cafe' });
    expect(getRecentMessagesMock).not.toHaveBeenCalled();
    expect(result.conversationId).toBe('new-conv-id');
    expect(appendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('throws a plain-language error when the Bedrock call fails', async () => {
    sendMock.mockRejectedValueOnce(new Error('ThrottlingException'));

    const { handler } = await import('../handler.mjs');

    await expect(handler({ message: 'Say hello' })).rejects.toThrow(
      "The copilot couldn't answer just now. Please try again."
    );
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it('throws a plain-language error when Bedrock returns no text content', async () => {
    sendMock.mockResolvedValueOnce({ output: { message: { content: [] } } });

    const { handler } = await import('../handler.mjs');

    await expect(handler({ message: 'Say hello' })).rejects.toThrow(
      "The copilot couldn't answer just now. Please try again."
    );
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it('rejects a missing message before calling Bedrock or memory', async () => {
    const { handler } = await import('../handler.mjs');

    await expect(handler({ message: '' })).rejects.toThrow('message is required');
    expect(sendMock).not.toHaveBeenCalled();
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(getRecentMessagesMock).not.toHaveBeenCalled();
  });

  it('throws a plain-language error when the memory lookup fails, without calling Bedrock', async () => {
    getRecentMessagesMock.mockRejectedValueOnce(new Error('connection refused'));

    const { handler } = await import('../handler.mjs');

    await expect(handler({ message: 'Say hello', conversationId: 'abc-123' })).rejects.toThrow(
      "The copilot couldn't answer just now. Please try again."
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('still returns the reply when saving the turn afterwards fails', async () => {
    sendMock.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'Still works' }] } },
    });
    appendMessageMock.mockRejectedValue(new Error('write failed'));

    const { handler } = await import('../handler.mjs');
    const result = await handler({ message: 'Say hello', conversationId: 'abc-123' });

    expect(result).toEqual({ reply: 'Still works', conversationId: 'abc-123' });
  });
});
