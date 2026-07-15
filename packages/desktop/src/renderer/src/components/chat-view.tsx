import { useEffect, useRef } from 'react';
import type { ChatMessage, SessionSnapshot } from '../../../shared/ipc.js';
import { MessageBubble } from './message-bubble.js';

const EMPTY_TITLE = '开始一段新的任务';
const EMPTY_DESCRIPTION = '告诉 Pure Agent 你想完成什么，它会在这个会话中保留完整的上下文。';
const MESSAGE_ROLE = 'assistant';

interface ChatViewProps {
  session: SessionSnapshot | null;
}

export function ChatView({ session }: ChatViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const latestContent = session?.streamingMessage?.content;
  const latestReasoning = session?.streamingMessage?.reasoningContent;

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [latestContent, latestReasoning, session?.messages.length]);

  if (!session) {
    return <section className="chat-view" aria-label="当前会话" />;
  }

  const streamingMessage: ChatMessage | null = session.streamingMessage
    ? {
      id: session.streamingMessage.id,
      role: MESSAGE_ROLE,
      content: session.streamingMessage.content,
      reasoningContent: session.streamingMessage.reasoningContent,
      createdAt: session.updatedAt,
    }
    : null;
  const isEmpty = session.messages.length === 0 && !streamingMessage;

  return (
    <section className="chat-view" aria-label="当前会话">
      <div className="conversation-scroll" ref={scrollContainerRef}>
        {isEmpty ? (
          <div className="empty-state">
            <h2>{EMPTY_TITLE}</h2>
            <p>{EMPTY_DESCRIPTION}</p>
          </div>
        ) : (
          <div className="message-stack">
            {session.messages.map((message) => (
              <MessageBubble isStreaming={false} key={message.id} message={message} />
            ))}
            {streamingMessage && <MessageBubble isStreaming message={streamingMessage} />}
            {session.errorMessage && <p className="session-error">{session.errorMessage}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
