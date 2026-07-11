import { Box, Text } from 'ink';
import type { UIMessage } from '../types.js';
import { getMessagePresentation } from './message-presentation.js';

interface MessageProps {
  msg: UIMessage;
}

const MESSAGE_MARGIN_BOTTOM = 1;
const THOUGHT_MARGIN_TOP = 1;
const USER_HORIZONTAL_PADDING = 1;
const THOUGHT_LABEL = 'Thought';

export function Message({ msg }: MessageProps) {
  const presentation = getMessagePresentation(msg);
  const thoughtSuffix = presentation.thoughtLabel?.slice(THOUGHT_LABEL.length);

  return (
    <Box flexDirection="column" marginBottom={MESSAGE_MARGIN_BOTTOM}>
      {presentation.thoughtLabel && thoughtSuffix && (
        <Box marginTop={THOUGHT_MARGIN_TOP}>
          <Text backgroundColor="blue" color="white">
            {THOUGHT_LABEL}
          </Text>
          <Text dimColor>{thoughtSuffix}</Text>
        </Box>
      )}
      <Box
        width="100%"
        backgroundColor={presentation.backgroundColor}
        paddingX={msg.role === 'user' ? USER_HORIZONTAL_PADDING : 0}
      >
        <Text color={presentation.color}>
          {presentation.prefix}
          {msg.content}
        </Text>
        {msg.toolCallNames && msg.toolCallNames.length > 0 && (
          <Text dimColor>
            {' '}
            [{msg.toolCallNames.join(', ')}]
          </Text>
        )}
      </Box>
    </Box>
  );
}
