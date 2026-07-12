import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
    ConverseCommand: vi.fn().mockImplementation((input) => ({ input })),
  };
});

describe('handler', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    process.env.AWS_REGION = 'us-east-1';
    process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-5-sonnet-test';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('extracts the reply text from a successful Converse response', async () => {
    sendMock.mockResolvedValueOnce({
      output: {
        message: {
          content: [{ text: 'Hello, ' }, { text: 'how can I help your cafe today?' }],
        },
      },
    });

    const { handler } = await import('../handler.mjs');
    const result = await handler({ message: 'Say hello', conversationId: 'abc-123' });

    expect(result).toEqual({ reply: 'Hello, how can I help your cafe today?' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('throws a plain-language error when the Bedrock call fails', async () => {
    sendMock.mockRejectedValueOnce(new Error('ThrottlingException'));

    const { handler } = await import('../handler.mjs');

    await expect(handler({ message: 'Say hello' })).rejects.toThrow(
      "The copilot couldn't answer just now. Please try again."
    );
  });

  it('throws a plain-language error when Bedrock returns no text content', async () => {
    sendMock.mockResolvedValueOnce({ output: { message: { content: [] } } });

    const { handler } = await import('../handler.mjs');

    await expect(handler({ message: 'Say hello' })).rejects.toThrow(
      "The copilot couldn't answer just now. Please try again."
    );
  });

  it('rejects a missing message before calling Bedrock', async () => {
    const { handler } = await import('../handler.mjs');

    await expect(handler({ message: '' })).rejects.toThrow('message is required');
    expect(sendMock).not.toHaveBeenCalled();
  });
});
