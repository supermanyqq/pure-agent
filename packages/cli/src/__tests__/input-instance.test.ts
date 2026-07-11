import { describe, expect, it } from 'vitest';
import { getNextInputInstanceKey } from '../input-instance.js';

const INITIAL_INPUT_INSTANCE_KEY = 0;

describe('getNextInputInstanceKey', () => {
  it('成功 Tab 补全时递增输入实例键', () => {
    expect(getNextInputInstanceKey(INITIAL_INPUT_INSTANCE_KEY, true)).toBe(1);
  });

  it('未补全时保留输入实例键', () => {
    expect(getNextInputInstanceKey(INITIAL_INPUT_INSTANCE_KEY, false)).toBe(
      INITIAL_INPUT_INSTANCE_KEY,
    );
  });
});
