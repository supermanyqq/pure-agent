import { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentStatus } from '../types.js';
import { CommandMenu } from './CommandMenu.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onCancelApiKeyEntry: () => void;
  status: AgentStatus;
  mode: 'chat' | 'api-key';
}

export function InputBar({ onSubmit, onAbort, onCancelApiKeyEntry, status, mode }: InputBarProps) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const disabled = status === 'thinking' || status === 'streaming' || status === 'executing';
  const isApiKeyEntry = mode === 'api-key';

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    if (!isApiKeyEntry) {
      setHistory((prev) => [...prev, trimmed]);
      setHistoryIdx(-1);
    }
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

      if (isApiKeyEntry && key.ctrl && inputStr === 'c') {
        setInput('');
        onCancelApiKeyEntry();
        return;
      }

      if (isApiKeyEntry) return;

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
    <Box marginTop={1} flexDirection="column">
      {!isApiKeyEntry && <CommandMenu input={input} />}
      <Box flexDirection="row">
        <Text color="cyan" bold>
          {isApiKeyEntry ? 'API key (hidden) > ' : '> '}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={isApiKeyEntry ? 'Paste API key and press Enter…' : 'Type a message or / for commands…'}
          mask={isApiKeyEntry ? '*' : undefined}
        />
      </Box>
    </Box>
  );
}
