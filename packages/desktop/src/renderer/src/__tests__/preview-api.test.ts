import { describe, expect, it, vi } from 'vitest';
import { createPreviewDesktopApi } from '../preview-api.js';

const USER_CONTENT = '解释这段 Markdown';
const FIRST_SESSION_INDEX = 0;

describe('createPreviewDesktopApi', () => {
  it('provides an in-memory conversation only for renderer preview', async () => {
    const api = createPreviewDesktopApi();
    const updateListener = vi.fn();
    const unsubscribe = api.onSessionUpdated(updateListener);
    const session = await api.createSession();

    await api.sendMessage({ sessionId: session.id, content: USER_CONTENT });

    const updatedSession = (await api.listSessions())[FIRST_SESSION_INDEX];
    expect(updatedSession?.messages.map(({ content }) => content)).toEqual([
      USER_CONTENT,
      expect.stringContaining('### 已收到'),
    ]);
    expect(updateListener).toHaveBeenCalled();
    unsubscribe();
  });
});
