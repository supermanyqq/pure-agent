import { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentStatus } from '../types.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  onAbort: () => void;
  status: AgentStatus;
}

export function InputBar({ onSubmit, onAbort, status }: InputBarProps) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const disabled = status !== 'idle';

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);
    setInput('');
    onSubmit(trimmed);
  };

  // 全局快捷键: Ctrl+C 中断，上下箭头翻历史
  useInput(
    (inputStr, key) => {
      if (disabled) {
        // 在思考/流式输出时，Ctrl+C 中断
        if (key.ctrl && inputStr === 'c') {
          onAbort();
        }
        return;
      }

      if (key.upArrow) {
        const newIdx = historyIdx < history.length - 1 ? historyIdx + 1 : historyIdx;
        setHistoryIdx(newIdx);
        if (newIdx >= 0) {
          setInput(history[history.length - 1 - newIdx]);
        }
        return;
      }
      if (key.downArrow) {
        const newIdx = historyIdx > 0 ? historyIdx - 1 : -1;
        setHistoryIdx(newIdx);
        setInput(newIdx >= 0 ? history[history.length - 1 - newIdx] : '');
        return;
      }
    },
    { isActive: true },
  );

  if (disabled) {
    return (
      <Box marginTop={1}>
        <Text dimColor>
          {status === 'thinking' || status === 'streaming'
            ? 'Waiting for response… (Ctrl+C to cancel)'
            : status === 'executing'
              ? 'Executing tools… (Ctrl+C to cancel)'
              : 'Processing…'}
        </Text>
      </Box>
    );
  }

  return (
    <Box marginTop={1} flexDirection="row">
      <Text color="cyan" bold>
        &gt;{' '}
      </Text>
      <TextInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        placeholder="Type a message…"
      />
    </Box>
  );
}
