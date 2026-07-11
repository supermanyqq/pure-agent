import { Box, Text } from 'ink';
import type { AgentStatus, TurnStatus, FinishReason } from '../types.js';
import type { SessionSettings } from '../session-settings.js';

interface StatusBarProps {
  status: AgentStatus;
  currentStep: number;
  toolCallNames: string[];
  lastError: string | null;
  lastStatus: TurnStatus | null;
  lastFinishReason: FinishReason | null;
  settings: SessionSettings;
}

export function StatusBar({
  status,
  currentStep,
  toolCallNames,
  lastError,
  lastStatus,
  lastFinishReason,
  settings,
}: StatusBarProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{`Model: ${settings.model} · Effort: ${settings.effort}`}</Text>
      <Box flexDirection="row">
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
    </Box>
  );
}
