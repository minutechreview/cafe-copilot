// Transport-agnostic chat handler. Takes {message, conversationId}, returns {reply,
// conversationId}. Same handler is wired up locally by dev-server.mjs and, later, deployed
// to AWS Lambda behind a thin adapter — no transport-specific code belongs in this file.
//
// Conversation persistence lives in memory/store.mjs (CockroachDB): each call ensures a
// conversation exists, loads recent history as Converse context, and saves both sides of
// the turn once the model has replied.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { createConversation, appendMessage, getRecentMessages } from '../memory/store.mjs';

const SYSTEM_PROMPT = [
  'You are Cafe Copilot, a plain-language assistant for a small independent cafe owner.',
  'Be honest and concise. Never invent numbers, sales figures, or facts you were not given —',
  'if you do not know something, say so plainly instead of guessing. Avoid technical jargon;',
  'write the way you would explain things to a busy, non-technical shop owner.',
].join(' ');

// Constructed once at module load so a warm Lambda invocation (or the long-lived dev
// server process) reuses the same client/connection instead of paying setup cost per call.
const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

// C2 has no auth/business-selection layer yet (that's C3+); every conversation belongs to
// the single seeded demo café until then.
const DEFAULT_BUSINESS_ID = process.env.DEMO_BUSINESS_ID || 'demo-cafe';
const HISTORY_LIMIT = 12;
const GENERIC_ERROR = "The copilot couldn't answer just now. Please try again.";

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

function toConverseMessages(history) {
  return history.map((entry) => ({ role: entry.role, content: [{ text: entry.content }] }));
}

/**
 * @param {{ message: string, conversationId?: string, businessId?: string }} input
 * @returns {Promise<{ reply: string, conversationId: string }>}
 */
export async function handler({ message, conversationId, businessId } = {}) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new ValidationError('message is required');
  }

  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error('BEDROCK_MODEL_ID is not configured');
  }

  let activeConversationId = conversationId;
  let history = [];
  try {
    if (!activeConversationId) {
      activeConversationId = await createConversation({ businessId: businessId || DEFAULT_BUSINESS_ID });
    } else {
      history = await getRecentMessages(activeConversationId, HISTORY_LIMIT);
    }
  } catch (err) {
    console.error('[agent] memory lookup failed', {
      conversationId: conversationId ?? null,
      error: err?.message ?? String(err),
    });
    throw new Error(GENERIC_ERROR);
  }

  let response;
  try {
    response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [...toConverseMessages(history), { role: 'user', content: [{ text: message }] }],
      })
    );
  } catch (err) {
    console.error('[agent] Bedrock Converse call failed', {
      conversationId: activeConversationId,
      error: err?.message ?? String(err),
    });
    throw new Error(GENERIC_ERROR);
  }

  const reply = extractReplyText(response);
  if (!reply) {
    console.error('[agent] Bedrock returned an empty reply', {
      conversationId: activeConversationId,
    });
    throw new Error(GENERIC_ERROR);
  }

  try {
    await appendMessage({ conversationId: activeConversationId, role: 'user', content: message });
    await appendMessage({ conversationId: activeConversationId, role: 'assistant', content: reply });
  } catch (err) {
    // The user already has their answer — a persistence hiccup shouldn't turn into a
    // failed request, but it does mean this turn won't be remembered, so log it loudly.
    console.error('[agent] failed to persist conversation turn', {
      conversationId: activeConversationId,
      error: err?.message ?? String(err),
    });
  }

  return { reply, conversationId: activeConversationId };
}
