import { Static, Box, Text } from 'ink';
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
      {/* 已完成消息 — 冻入 Static，永不重渲染 */}
      <Static items={completedMessages}>
        {(msg) => (
          <Message key={msg.id} msg={msg} />
        )}
      </Static>

      {/* 流式输出中的文本 */}
      {(status === 'streaming' || status === 'thinking') && streamingText ? (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color="white">{streamingText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
