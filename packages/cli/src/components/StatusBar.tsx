import { Box, Text } from 'ink';
import type { AgentStatus, TurnStatus, FinishReason } from '../types.js';

interface StatusBarProps {
  status: AgentStatus;
  currentStep: number;
  toolCallNames: string[];
  lastError: string | null;
  lastStatus: TurnStatus | null;
  lastFinishReason: FinishReason | null;
}

export function StatusBar({
  status,
  currentStep,
  toolCallNames,
  lastError,
  lastStatus,
  lastFinishReason,
}: StatusBarProps) {
  // 无状态时不显示
  if (status === 'idle' && !lastError && !lastStatus) return null;

  return (
    <Box flexDirection="row" marginTop={1}>
      {status === 'thinking' && (
        <Text dimColor>Thinking{currentStep > 0 ? ` (step ${currentStep})` : ''}…</Text>
      )}
      {status === 'streaming' && (
        <Text dimColor>Streaming…</Text>
      )}
      {status === 'executing' && toolCallNames.length > 0 && (
        <Text dimColor>
          Executing: {toolCallNames.join(', ')}…
        </Text>
      )}
      {status === 'error' && lastError && (
        <Text color="red">Error: {lastError}</Text>
      )}
      {status === 'idle' && lastStatus && lastStatus !== 'completed' && (
        <Text color="yellow">
          Turn ended: {lastStatus}
          {lastFinishReason ? ` (${lastFinishReason})` : ''}
        </Text>
      )}
    </Box>
  );
}
