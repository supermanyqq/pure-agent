import { useState, useEffect } from 'react';
import { code } from '@streamdown/code';
import { Streamdown } from 'streamdown';
import type { ChatMessage } from '../../../shared/ipc.js';

const STREAMDOWN_PLUGINS = { code };

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming: boolean;
}

/** Renders the model's reasoning/thinking content as a collapsible section. */
function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(isStreaming);

  // Auto-expand when streaming starts; user can collapse manually
  useEffect(() => {
    if (isStreaming) {
      setExpanded(true);
    }
  }, [isStreaming]);

  if (!content.trim()) return null;

  return (
    <div className="thinking-block">
      <button
        className="thinking-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="thinking-label">{isStreaming ? 'Thinking...' : 'Thinking'}</span>
        <span className="thinking-chevron">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className="thinking-content">
          <p>{content.slice(0, 2000)}</p>
          {content.length > 2000 && (
            <p className="thinking-truncated">
              (Content truncated — {content.length.toLocaleString()} chars total)
            </p>
          )}
        </div>
      )}
    </div>
  );
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
      {message.reasoningContent && (
        <ThinkingBlock content={message.reasoningContent} isStreaming={isStreaming} />
      )}
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
