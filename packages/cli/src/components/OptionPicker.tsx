import { Box, Text } from 'ink';
import type { RuntimeOption } from '../runtime-options.js';

const FIRST_OPTION_INDEX = 0;
const NEXT_OPTION_INCREMENT = 1;
const PREVIOUS_OPTION_OFFSET = 1;
const SELECTED_PREFIX = '› ';
const UNSELECTED_PREFIX = '  ';
const OPTION_SEPARATOR = ' — ';

export type PickerDirection = 'up' | 'down';

export interface PickerIndexInput {
  currentIndex: number;
  direction: PickerDirection;
  optionCount: number;
}

export interface OptionPickerProps {
  options: readonly RuntimeOption<string>[];
  selectedIndex: number;
}

/** Returns a wrapped option index after one keyboard move. */
export function getNextPickerIndex({
  currentIndex,
  direction,
  optionCount,
}: PickerIndexInput): number {
  if (optionCount === FIRST_OPTION_INDEX) return FIRST_OPTION_INDEX;
  if (direction === 'up') {
    return (currentIndex + optionCount - PREVIOUS_OPTION_OFFSET) % optionCount;
  }
  return (currentIndex + NEXT_OPTION_INCREMENT) % optionCount;
}

/** Renders a keyboard-driven list of session options. */
export function OptionPicker({ options, selectedIndex }: OptionPickerProps) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <Text key={option.value} color={selected ? 'cyan' : undefined} bold={selected}>
            {selected ? SELECTED_PREFIX : UNSELECTED_PREFIX}
            {option.label}
            <Text dimColor>{`${OPTION_SEPARATOR}${option.description}`}</Text>
          </Text>
        );
      })}
      <Text dimColor>↑/↓ select · Enter apply · Esc cancel</Text>
    </Box>
  );
}
