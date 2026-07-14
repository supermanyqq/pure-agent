import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../../../shared/ipc.js';
import { MessageBubble } from '../message-bubble.js';

const streamdownSpy = vi.hoisted(() => vi.fn(({ children }: { children: string }) => children));

vi.mock('streamdown', () => ({ Streamdown: streamdownSpy }));
vi.mock('@streamdown/code', () => ({ code: 'code-plugin' }));

const ASSISTANT_MESSAGE: ChatMessage = {
  id: 'message-1',
  role: 'assistant',
  content: '## Streaming heading',
  createdAt: 1,
};

describe('MessageBubble', () => {
  it('hands assistant streaming markdown to Streamdown with animation enabled', () => {
    renderToStaticMarkup(<MessageBubble message={ASSISTANT_MESSAGE} isStreaming />);

    expect(streamdownSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        children: ASSISTANT_MESSAGE.content,
        isAnimating: true,
      }),
      undefined,
    );
  });
});
