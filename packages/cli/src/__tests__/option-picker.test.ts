import { describe, expect, it } from 'vitest';
import { getNextPickerIndex } from '../components/OptionPicker.js';

describe('getNextPickerIndex', () => {
  it('向上越过首项时选择最后一项', () => {
    expect(getNextPickerIndex({ currentIndex: 0, direction: 'up', optionCount: 2 })).toBe(1);
  });

  it('向下越过末项时选择首项', () => {
    expect(getNextPickerIndex({ currentIndex: 1, direction: 'down', optionCount: 2 })).toBe(0);
  });
});
