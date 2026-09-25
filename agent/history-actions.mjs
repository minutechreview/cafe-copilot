// Buffered (never streamed) JSON handlers for the four conversation-management actions the
// History sidebar drives: list_conversations, get_conversation, rename_conversation,
// delete_conversation. These never enter the chat/Bedrock path: resolveTrustedChatInput
// (handler.mjs) hard-requires a `message` field these requests don't send, so transports
// (lambda.mjs, dev-server.mjs) detect payload.action and route here instead, before ever
// calling resolveTrustedChatInput. Authenticated-only by design — no demo/legacy access.
import { resolveAuthContext } from './auth-context.mjs';
import {
  listConversations,
  conversationExists,
  getConversationMessages,
  renameConversation,
  deleteConversation,
} from '../memory/store.mjs';

export const MANAGEMENT_ACTIONS = new Set([
  'list_conversations',
  'get_conversation',
  'rename_conversation',
  'delete_conversation',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export function isManagementAction(action) {
  return typeof action === 'string' && MANAGEMENT_ACTIONS.has(action);
}

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`${field} must be a valid UUID`);
  }
  return value;
}

/**
 * Handles one of the four conversation-management actions as a single buffered JSON response.
 * @param {{ headers?: object, payload?: object, signal?: AbortSignal }} input
 * @param {{ resolveAuth?: Function }} [deps] injectable auth resolver for testing
 * @returns {Promise<object>} the JSON-serializable success response body
 */
export async function handleManagementAction(
  { headers = {}, payload = {}, signal } = {},
  { resolveAuth = resolveAuthContext } = {}
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const action = payload.action;
  if (!isManagementAction(action)) {
    throw new ValidationError(
      'action must be one of list_conversations, get_conversation, rename_conversation, delete_conversation'
    );
  }

  const requestedMode = typeof payload.mode === 'string' ? payload.mode.trim().toLowerCase() : payload.mode;
  if (requestedMode !== 'authenticated') {
    throw new ValidationError('mode is required and must be "authenticated" for this action');
  }

  if (action !== 'list_conversations') {
    requireUuid(payload.conversationId, 'conversationId');
  }

  if (action === 'rename_conversation' && (typeof payload.title !== 'string' || !payload.title.trim())) {
    throw new ValidationError('title is required');
  }

  const resolved = await resolveAuth({ headers, body: { ...payload, mode: 'authenticated' }, signal }, { signal });
  if (resolved?.mode !== 'authenticated' || !resolved.userId || !resolved.businessId) {
    throw new Error('Authentication context is incomplete');
  }

  const principal = { businessId: resolved.businessId, actorId: resolved.userId, accessMode: 'authenticated' };
  const conversationId = payload.conversationId;

  switch (action) {
    case 'list_conversations': {
      const conversations = await listConversations(principal, { signal });
      return { conversations: conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })) };
    }
    case 'get_conversation': {
      const owned = await conversationExists(principal, conversationId, { signal });
      if (!owned) throw new NotFoundError('Conversation not found');
      const messages = await getConversationMessages(principal, conversationId, { signal });
      return { messages };
    }
    case 'rename_conversation': {
      const updated = await renameConversation(principal, conversationId, payload.title, { signal });
      if (!updated) throw new NotFoundError('Conversation not found');
      return {};
    }
    case 'delete_conversation': {
      const deleted = await deleteConversation(principal, conversationId, { signal });
      if (!deleted) throw new NotFoundError('Conversation not found');
      return {};
    }
    default:
      throw new ValidationError('Unsupported action');
  }
}
