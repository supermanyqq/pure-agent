import { Box, Text } from 'ink';
import type { UIMessage } from '../types.js';

interface MessageProps {
  msg: UIMessage;
}

const ROLE_COLORS: Record<UIMessage['role'], string> = {
  user: 'cyan',
  assistant: 'white',
  system: 'grey',
  tool: 'yellow',
};

const ROLE_LABELS: Record<UIMessage['role'], string> = {
  user: 'You',
  assistant: 'Agent',
  system: 'System',
  tool: 'Tool',
};

export function Message({ msg }: MessageProps) {
  const color = ROLE_COLORS[msg.role];

  return (
    <Box flexDirection="column" marginBottom={msg.role === 'user' ? 1 : 0}>
      <Box>
        <Text bold color={color}>
          {ROLE_LABELS[msg.role]}
        </Text>
        {msg.toolCallNames && msg.toolCallNames.length > 0 && (
          <Text dimColor>
            {' '}
            [{msg.toolCallNames.join(', ')}]
          </Text>
        )}
        <Text dimColor>:</Text>
      </Box>
      {msg.content ? (
        <Box paddingLeft={2}>
          <Text color={color}>{msg.content}</Text>
        </Box>
      ) : null}
      {msg.role !== 'user' && <Box marginBottom={1} />}
    </Box>
  );
}
