import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { getNextCommandCompletion } from '../commands/completion.js';
import type { CommandCompletionState } from '../commands/completion.js';
import { getNextPickerIndex, OptionPicker } from './OptionPicker.js';
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '../runtime-options.js';
import type { RuntimeOption } from '../runtime-options.js';
import type { AgentStatus, PickerState } from '../types.js';
import type { SessionSettings } from '../session-settings.js';
import { CommandMenu } from './CommandMenu.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onCancelApiKeyEntry: () => void;
  onChoosePickerValue: (value: string) => void;
  onCancelPicker: () => void;
  status: AgentStatus;
  mode: 'chat' | 'api-key';
  picker: PickerState | null;
  settings: SessionSettings;
}

function getPickerOptions(picker: PickerState): readonly RuntimeOption<string>[] {
  return picker.kind === 'model' ? MODEL_OPTIONS : EFFORT_OPTIONS;
}

function getCurrentPickerValue(picker: PickerState, settings: SessionSettings): string {
  return picker.kind === 'model' ? settings.model : settings.effort;
}

export function InputBar({
  onSubmit,
  onAbort,
  onCancelApiKeyEntry,
  onChoosePickerValue,
  onCancelPicker,
  status,
  mode,
  picker,
  settings,
}: InputBarProps) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [completionState, setCompletionState] = useState<CommandCompletionState | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const disabled = status === 'thinking' || status === 'streaming' || status === 'executing';
  const isApiKeyEntry = mode === 'api-key';
  const isPickerOpen = picker !== null;

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    if (!isApiKeyEntry) {
      setHistory((prev) => [...prev, trimmed]);
      setHistoryIdx(-1);
    }
    setInput('');
    setCompletionState(null);
    onSubmit(trimmed);
  };

  const handleChange = (value: string): void => {
    setCompletionState(null);
    setInput(value);
  };

  useEffect(() => {
    setCompletionState(null);
    if (!picker) return;
    const options = getPickerOptions(picker);
    const currentValue = getCurrentPickerValue(picker, settings);
    const currentIndex = options.findIndex((option) => option.value === currentValue);
    setPickerIndex(currentIndex < 0 ? 0 : currentIndex);
    setInput('');
  }, [mode, picker, settings]);

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

      if (picker) {
        const options = getPickerOptions(picker);
        if (key.upArrow || key.downArrow) {
          setPickerIndex((currentIndex) => getNextPickerIndex({
            currentIndex,
            direction: key.upArrow ? 'up' : 'down',
            optionCount: options.length,
          }));
          return;
        }
        if (key.return) {
          const selectedOption = options[pickerIndex];
          if (selectedOption) onChoosePickerValue(selectedOption.value);
          return;
        }
        if (key.escape) {
          onCancelPicker();
          return;
        }
        return;
      }

      if (isApiKeyEntry) return;

      if (key.tab) {
        const completion = getNextCommandCompletion(input, completionState);
        if (completion) {
          setInput(completion.input);
          setCompletionState(completion.state);
        }
        return;
      }

      setCompletionState(null);

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

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderTop
      borderBottom
      borderLeft={false}
      borderRight={false}
      borderDimColor
    >
      {disabled ? (
        <Text dimColor>
          {status === 'thinking' || status === 'streaming'
            ? 'Waiting for response… (Ctrl+C to cancel)'
            : status === 'executing'
              ? 'Executing tools… (Ctrl+C to cancel)'
              : 'Processing…'}
        </Text>
      ) : picker ? (
        <OptionPicker options={getPickerOptions(picker)} selectedIndex={pickerIndex} />
      ) : (
        <>
          {!isApiKeyEntry && <CommandMenu input={input} />}
          <Box flexDirection="row">
            <Text color="cyan" bold>
              {isApiKeyEntry ? 'API key (hidden) > ' : '> '}
            </Text>
            <TextInput
              value={input}
              onChange={handleChange}
              onSubmit={handleSubmit}
              placeholder={isApiKeyEntry ? 'Paste API key and press Enter…' : 'Type a message or / for commands…'}
              mask={isApiKeyEntry ? '*' : undefined}
            />
          </Box>
        </>
      )}
    </Box>
  );
}
