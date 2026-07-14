import { code } from '@streamdown/code';
import { Streamdown } from 'streamdown';
import type { ChatMessage } from '../../../shared/ipc.js';

const STREAMDOWN_PLUGINS = { code };

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming: boolean;
}

/** Renders user text plainly and assistant Markdown through the streaming-safe renderer. */
export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <article className="message-bubble message-bubble-user">
        <p>{message.content}</p>
      </article>
    );
  }

  return (
    <article className="message-bubble message-bubble-assistant">
      <div className="message-author">Pure Agent</div>
      <Streamdown
        controls={false}
        isAnimating={isStreaming}
        plugins={STREAMDOWN_PLUGINS}
      >
        {message.content}
      </Streamdown>
    </article>
  );
}
