import { Box, Text } from 'ink';
import { Message } from './Message.js';
import type { UIMessage, AgentStatus } from '../types.js';

interface ChatViewProps {
  completedMessages: UIMessage[];
  streamingText: string;
  status: AgentStatus;
}

export function ChatView({ completedMessages, streamingText, status }: ChatViewProps) {
  return (
    <Box flexDirection="column">
      {completedMessages.map((message) => (
        <Message key={message.id} msg={message} />
      ))}

      {/* 流式输出中的文本 */}
      {(status === 'streaming' || status === 'thinking') && streamingText ? (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color="white">{streamingText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
