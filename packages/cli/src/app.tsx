import React, { useEffect, useRef } from 'react';
import { useApp, Box, Text } from 'ink';
import { useAgent } from './hooks/useAgent.js';
import { ChatView } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBar } from './components/InputBar.js';

interface AppProps {
  initialQuestion?: string;
}

export function App({ initialQuestion }: AppProps) {
  const { exit } = useApp();
  const { state, submit, abort, cancelApiKeyEntry } = useAgent();

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
    <Box flexDirection="column" padding={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text bold color="green">
          Pure Agent
        </Text>
        <Text dimColor> — AI Chat (Ctrl+C to cancel, / for commands)</Text>
      </Box>

      {state.apiKeyStatus === 'required' && (
        <Box flexDirection="column" marginY={1}>
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

      {/* 对话区域 */}
      {state.completedMessages.length > 0 && (
        <ChatView
          completedMessages={state.completedMessages}
          streamingText={state.streamingText}
          status={state.status}
        />
      )}

      {/* 流式输出（还没有完成消息但有流式文本时） */}
      {state.completedMessages.length === 0 && state.streamingText && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color="white">{state.streamingText}</Text>
        </Box>
      )}

      {state.notice && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text dimColor>{state.notice}</Text>
        </Box>
      )}

      {/* 状态栏 */}
      <StatusBar
        status={state.status}
        currentStep={state.currentStep}
        toolCallNames={state.toolCallNames}
        lastError={state.lastError}
        lastStatus={state.lastStatus}
        lastFinishReason={state.lastFinishReason}
        settings={state.settings}
      />

      {/* 输入栏 */}
      <InputBar
        onSubmit={(text) => {
          submit(text);
        }}
        onAbort={abort}
        onCancelApiKeyEntry={cancelApiKeyEntry}
        status={state.status}
        mode={state.apiKeyStatus === 'entering' ? 'api-key' : 'chat'}
      />
    </Box>
  );
}
