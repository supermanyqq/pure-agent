import { useApp } from 'ink';
import { useAgent } from './hooks/useAgent.js';
import { ChatView } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBar } from './components/InputBar.js';
import { Box, Text } from 'ink';

interface AppProps {
  /** 初始问题（命令行参数模式，直接提问并退出） */
  initialQuestion?: string;
}

export function App({ initialQuestion }: AppProps) {
  const { exit } = useApp();
  const { state, send, reset, abort } = useAgent();

  // 命令行参数模式：提问 → 等待完成 → 退出
  const hasSentRef = React.useRef(false);
  React.useEffect(() => {
    if (initialQuestion && !hasSentRef.current) {
      hasSentRef.current = true;
      send(initialQuestion).then(() => {
        // 等待渲染一帧后退出
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

      {/* 对话区域 */}
      <ChatView
        completedMessages={state.completedMessages}
        streamingText={state.streamingText}
        status={state.status}
      />

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
          if (text === '/new') {
            reset();
          } else {
            send(text);
          }
        }}
        onAbort={abort}
        status={state.status}
      />
    </Box>
  );
}

// 在 ESM 顶层需要显式导入 React（JSX 自动运行时需要）
import React from 'react';
