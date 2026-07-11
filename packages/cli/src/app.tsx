import React, { useEffect, useRef } from 'react';
import { useApp, useStdout, Box, Text } from 'ink';
import { CHAT_VIEW_LAYOUT, getAppHeight } from './app-layout.js';
import { useAgent } from './hooks/useAgent.js';
import { ChatView } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBar } from './components/InputBar.js';

interface AppProps {
  initialQuestion?: string;
}

export function App({ initialQuestion }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const {
    state,
    submit,
    abort,
    cancelApiKeyEntry,
    choosePickerValue,
    cancelPicker,
  } = useAgent();

  // 命令行参数模式
  const hasSentRef = useRef(false);
  useEffect(() => {
    if (initialQuestion && !hasSentRef.current) {
      hasSentRef.current = true;
      submit(initialQuestion).then(() => {
        setTimeout(() => exit(), 100);
      });
    }
  }, [initialQuestion, submit, exit]);

  return (
    <Box flexDirection="column" height={getAppHeight(stdout.rows)}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color="green">
            Pure Agent
          </Text>
          <Text dimColor> — AI Chat (Ctrl+C to cancel, / for commands)</Text>
        </Box>

        {state.apiKeyStatus === 'required' && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="yellow">
              API Key Required
            </Text>
            <Box paddingLeft={2}>
              <Text>Run /config set api-key to configure it securely.</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>
                Chat is unavailable until an API key is configured. Use /config for help.
              </Text>
            </Box>
          </Box>
        )}

        <Box {...CHAT_VIEW_LAYOUT}>
          <ChatView
            completedMessages={state.completedMessages}
            streamingText={state.streamingText}
            streamingThoughtDurationMs={state.streamingThoughtDurationMs}
            status={state.status}
          />
        </Box>

        {state.notice && (
          <Box paddingLeft={2} marginBottom={1}>
            <Text dimColor>{state.notice}</Text>
          </Box>
        )}

        <StatusBar
          status={state.status}
          currentStep={state.currentStep}
          toolCallNames={state.toolCallNames}
          lastError={state.lastError}
          lastStatus={state.lastStatus}
          lastFinishReason={state.lastFinishReason}
          settings={state.settings}
        />
      </Box>

      <InputBar
        onSubmit={(text) => {
          submit(text);
        }}
        onAbort={abort}
        onCancelApiKeyEntry={cancelApiKeyEntry}
        onChoosePickerValue={(value) => {
          void choosePickerValue(value);
        }}
        onCancelPicker={cancelPicker}
        status={state.status}
        mode={state.apiKeyStatus === 'entering' ? 'api-key' : 'chat'}
        picker={state.picker}
        settings={state.settings}
      />
    </Box>
  );
}
