import { Box } from 'ink';
import { Message } from './Message.js';
import type { UIMessage, AgentStatus } from '../types.js';

interface ChatViewProps {
  completedMessages: UIMessage[];
  streamingText: string;
  streamingThoughtDurationMs: number | null;
  status: AgentStatus;
}

const STREAMING_MESSAGE_ID = 'streaming-assistant-message';

export function ChatView({
  completedMessages,
  streamingText,
  streamingThoughtDurationMs,
  status,
}: ChatViewProps) {
  return (
    <Box flexDirection="column">
      {completedMessages.map((message) => (
        <Message key={message.id} msg={message} />
      ))}

      {(status === 'streaming' || status === 'thinking') && streamingText ? (
        <Message
          msg={{
            id: STREAMING_MESSAGE_ID,
            role: 'assistant',
            content: streamingText,
            thoughtDurationMs: streamingThoughtDurationMs ?? undefined,
          }}
        />
      ) : null}
    </Box>
  );
}
