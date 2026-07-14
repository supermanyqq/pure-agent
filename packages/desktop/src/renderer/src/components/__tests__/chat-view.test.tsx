import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '../../../../shared/ipc.js';
import { ChatView } from '../chat-view.js';

const TEST_UPDATED_AT = 1;
const EMPTY_SESSION: SessionSnapshot = {
  id: 'session-1',
  title: '界面预览',
  status: 'idle',
  messages: [],
  streamingMessage: null,
  errorMessage: null,
  updatedAt: TEST_UPDATED_AT,
};

describe('ChatView', () => {
  it('keeps the empty conversation focused on the task prompt', () => {
    const markup = renderToStaticMarkup(<ChatView session={EMPTY_SESSION} />);

    expect(markup).toContain('开始一段新的任务');
    expect(markup).toContain('告诉 Pure Agent 你想完成什么');
    expect(markup).not.toContain('conversation-header');
    expect(markup).not.toContain('empty-orbit');
    expect(markup).not.toContain('suggestion-list');
  });
});
