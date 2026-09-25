import { describe, it, expect, vi, beforeEach } from 'vitest';

const listConversationsMock = vi.fn();
const conversationExistsMock = vi.fn();
const getConversationMessagesMock = vi.fn();
const renameConversationMock = vi.fn();
const deleteConversationMock = vi.fn();

vi.mock('../../memory/store.mjs', () => ({
  listConversations: listConversationsMock,
  conversationExists: conversationExistsMock,
  getConversationMessages: getConversationMessagesMock,
  renameConversation: renameConversationMock,
  deleteConversation: deleteConversationMock,
}));

const AUTH_RESOLVED = { mode: 'authenticated', userId: 'user-1', businessId: 'biz-1', accessToken: 'token' };
const VALID_UUID = '11111111-1111-4111-8111-111111111111';

function basePayload(overrides = {}) {
  return { mode: 'authenticated', businessId: 'biz-1', ...overrides };
}

beforeEach(() => {
  listConversationsMock.mockReset();
  conversationExistsMock.mockReset();
  getConversationMessagesMock.mockReset();
  renameConversationMock.mockReset();
  deleteConversationMock.mockReset();
});

describe('agent/history-actions.mjs', () => {
  describe('isManagementAction', () => {
    it('recognizes exactly the four management actions', async () => {
      const { isManagementAction } = await import('../history-actions.mjs');
      expect(isManagementAction('list_conversations')).toBe(true);
      expect(isManagementAction('get_conversation')).toBe(true);
      expect(isManagementAction('rename_conversation')).toBe(true);
      expect(isManagementAction('delete_conversation')).toBe(true);
      expect(isManagementAction('chat')).toBe(false);
      expect(isManagementAction(undefined)).toBe(false);
    });
  });

  describe('handleManagementAction', () => {
    it('rejects a missing/unknown action with a 400', async () => {
      const { handleManagementAction } = await import('../history-actions.mjs');
      await expect(
        handleManagementAction({ payload: basePayload({ action: 'not_a_real_action' }) })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(handleManagementAction({ payload: basePayload({}) })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects a non-authenticated mode with a 400 and never calls the store or auth', async () => {
      const resolveAuth = vi.fn();
      const { handleManagementAction } = await import('../history-actions.mjs');
      await expect(
        handleManagementAction(
          { payload: { mode: 'demo', action: 'list_conversations' } },
          { resolveAuth }
        )
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(resolveAuth).not.toHaveBeenCalled();
    });

    it('rejects a missing/malformed conversationId for get/rename/delete with a 400', async () => {
      const { handleManagementAction } = await import('../history-actions.mjs');
      const resolveAuth = vi.fn().mockResolvedValue(AUTH_RESOLVED);

      for (const action of ['get_conversation', 'rename_conversation', 'delete_conversation']) {
        await expect(
          handleManagementAction({ payload: basePayload({ action }) }, { resolveAuth })
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
          handleManagementAction({ payload: basePayload({ action, conversationId: 'not-a-uuid' }) }, { resolveAuth })
        ).rejects.toMatchObject({ statusCode: 400 });
      }
      expect(resolveAuth).not.toHaveBeenCalled();
    });

    it('rejects an empty/whitespace-only title on rename with a 400 before calling auth', async () => {
      const { handleManagementAction } = await import('../history-actions.mjs');
      const resolveAuth = vi.fn();
      await expect(
        handleManagementAction(
          { payload: basePayload({ action: 'rename_conversation', conversationId: VALID_UUID, title: '   ' }) },
          { resolveAuth }
        )
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(resolveAuth).not.toHaveBeenCalled();
    });

    it('list_conversations: happy path returns conversations mapped to the response shape', async () => {
      listConversationsMock.mockResolvedValueOnce([
        { id: 'conv-1', title: 'Chat one', updatedAt: new Date('2026-07-10T00:00:00Z') },
        { id: 'conv-2', title: null, updatedAt: new Date('2026-07-09T00:00:00Z') },
      ]);
      const resolveAuth = vi.fn().mockResolvedValue(AUTH_RESOLVED);
      const { handleManagementAction } = await import('../history-actions.mjs');

      const result = await handleManagementAction(
        { headers: { authorization: 'Bearer t' }, payload: basePayload({ action: 'list_conversations' }) },
        { resolveAuth }
      );

      expect(result).toEqual({
        conversations: [
          { id: 'conv-1', title: 'Chat one', updatedAt: new Date('2026-07-10T00:00:00Z') },
          { id: 'conv-2', title: null, updatedAt: new Date('2026-07-09T00:00:00Z') },
        ],
      });
      expect(listConversationsMock).toHaveBeenCalledWith(
        { businessId: 'biz-1', actorId: 'user-1', accessMode: 'authenticated' },
        expect.objectContaining({})
      );
    });

    it('get_conversation: happy path returns full message history', async () => {
      conversationExistsMock.mockResolvedValueOnce(true);
      getConversationMessagesMock.mockResolvedValueOnce([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);
      const resolveAuth = vi.fn().mockResolvedValue(AUTH_RESOLVED);
      const { handleManagementAction } = await import('../history-actions.mjs');

      const result = await handleManagementAction(
        { payload: basePayload({ action: 'get_conversation', conversationId: VALID_UUID }) },
        { resolveAuth }
      );

      expect(result).toEqual({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
    });

    it('get_conversation: a conversation not owned by this principal is a 4xx, not empty/500', async () => {
      conversationExistsMock.mockResolvedValueOnce(false);
      const resolveAuth = vi.fn().mockResolvedValue(AUTH_RESOLVED);
      const { handleManagementAction } = await import('../history-actions.mjs');

      await expect(
        handleManagementAction(
          { payload: basePayload({ action: 'get_conversation', conversationId: VALID_UUID }) },
          { resolveAuth }
        )
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(getConversationMessagesMock).not.toHaveBeenCalled();
    });

    it('rename_conversation: happy path renames and returns an empty success body', async () => {
      renameConversationMock.mockResolvedValueOnce(true);
      const resolveAuth = vi.fn().mockResolvedValue(AUTH_RESOLVED);
      const { handleManagementAction } = await import('../history-actions.mjs');

      const result = await handleManagementAction(
        { payload: basePayload({ action: 'rename_conversation', conversationId: VALID_UUID, title: 'New title' }) },
        { resolveAuth }
      );

      expect(result).toEqual({});
      expect(renameConversationMock).toHaveBeenCalledWith(
        { businessId: 'biz-1', actorId: 'user-1', accessMode: 'authenticated' },
        VALID_UUID,
        'New title',
        expect.objectContaining({})
      );
    });

    it('rename_conversation: renaming a conversation owned by someone else is a 4xx', async () => {
      renameConversationMock.mockResolvedValueOnce(false);
      const resolveAuth = vi.fn().mockResolvedValue(AUTH_RESOLVED);
      const { handleManagementAction } = await import('../history-actions.mjs');

      await expect(
        handleManagementAction(
          { payload: basePayload({ action: 'rename_conversation', conversationId: VALID_UUID, title: 'x' }) },
          { resolveAuth }
        )
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('delete_conversation: happy path deletes and returns an empty success body', async () => {
      deleteConversationMock.mockResolvedValueOnce(true);
      const resolveAuth = vi.fn().mockResolvedValue(AUTH_RESOLVED);
      const { handleManagementAction } = await import('../history-actions.mjs');

      const result = await handleManagementAction(
        { payload: basePayload({ action: 'delete_conversation', conversationId: VALID_UUID }) },
        { resolveAuth }
      );

      expect(result).toEqual({});
    });

    it('delete_conversation: deleting someone else\'s or a nonexistent conversation is a 4xx, not a silent success', async () => {
      deleteConversationMock.mockResolvedValueOnce(false);
      const resolveAuth = vi.fn().mockResolvedValue(AUTH_RESOLVED);
      const { handleManagementAction } = await import('../history-actions.mjs');

      await expect(
        handleManagementAction(
          { payload: basePayload({ action: 'delete_conversation', conversationId: VALID_UUID }) },
          { resolveAuth }
        )
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('propagates an auth denial (e.g. 401/403) without calling the store', async () => {
      const authError = new Error('Access denied: active owner or manager membership required.');
      authError.status = 403;
      const resolveAuth = vi.fn().mockRejectedValue(authError);
      const { handleManagementAction } = await import('../history-actions.mjs');

      await expect(
        handleManagementAction({ payload: basePayload({ action: 'list_conversations' }) }, { resolveAuth })
      ).rejects.toBe(authError);
      expect(listConversationsMock).not.toHaveBeenCalled();
    });
  });
});
