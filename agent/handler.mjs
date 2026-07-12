// Transport-agnostic chat handler. Takes {message, conversationId}, returns {reply}.
// Same handler is wired up locally by dev-server.mjs and, later, deployed to AWS Lambda
// behind a thin adapter — no transport-specific code belongs in this file.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const SYSTEM_PROMPT = [
  'You are Cafe Copilot, a plain-language assistant for a small independent cafe owner.',
  'Be honest and concise. Never invent numbers, sales figures, or facts you were not given —',
  'if you do not know something, say so plainly instead of guessing. Avoid technical jargon;',
  'write the way you would explain things to a busy, non-technical shop owner.',
].join(' ');

// Constructed once at module load so a warm Lambda invocation (or the long-lived dev
// server process) reuses the same client/connection instead of paying setup cost per call.
const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function extractReplyText(response) {
  const blocks = response?.output?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

/**
 * @param {{ message: string, conversationId?: string }} input
 * @returns {Promise<{ reply: string }>}
 */
export async function handler({ message, conversationId } = {}) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new ValidationError('message is required');
  }

  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error('BEDROCK_MODEL_ID is not configured');
  }

  let response;
  try {
    response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: message }] }],
      })
    );
  } catch (err) {
    console.error('[agent] Bedrock Converse call failed', {
      conversationId: conversationId ?? null,
      error: err?.message ?? String(err),
    });
    throw new Error("The copilot couldn't answer just now. Please try again.");
  }

  const reply = extractReplyText(response);
  if (!reply) {
    console.error('[agent] Bedrock returned an empty reply', {
      conversationId: conversationId ?? null,
    });
    throw new Error("The copilot couldn't answer just now. Please try again.");
  }

  return { reply };
}
