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
  const { state, send, reset, abort } = useAgent();

  // 命令行参数模式
  const hasSentRef = useRef(false);
  useEffect(() => {
    if (initialQuestion && !hasSentRef.current) {
      hasSentRef.current = true;
      send(initialQuestion).then(() => {
        setTimeout(() => exit(), 100);
      });
    }
  }, [initialQuestion, send, exit]);

  return (
    <Box flexDirection="column" padding={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text bold color="green">
          Pure Agent
        </Text>
        <Text dimColor> — AI Chat (Ctrl+C to exit, /new to reset)</Text>
      </Box>

      {/* 启动时的配置错误 */}
      {state.status === 'error' && state.lastError && state.completedMessages.length === 0 && (
        <Box flexDirection="column" marginY={1}>
          <Text bold color="red">
            Configuration Error
          </Text>
          <Box paddingLeft={2}>
            <Text color="red">{state.lastError}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Set PURE_AGENT_API_KEY environment variable or configure ~/.pure-agent/config.json
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

      {/* 状态栏 */}
      <StatusBar
        status={state.status}
        currentStep={state.currentStep}
        toolCallNames={state.toolCallNames}
        lastError={state.lastError}
        lastStatus={state.lastStatus}
        lastFinishReason={state.lastFinishReason}
      />

      {/* 输入栏 */}
      <InputBar
        onSubmit={(text) => {
          if (text === '/new') reset();
          else send(text);
        }}
        onAbort={abort}
        status={state.status}
      />
    </Box>
  );
}
