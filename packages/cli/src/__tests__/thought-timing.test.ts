import { describe, expect, it } from 'vitest';
import {
  clearThoughtTiming,
  createThoughtTimingState,
  finishThoughtTiming,
  startThoughtTiming,
} from '../thought-timing.js';

const START_TIME_MS = 100;
const END_TIME_MS = 3_450;
const EXPECTED_DURATION_MS = 3_350;

describe('thought timing', () => {
  it('从 thinking 到首个可见结果记录一次耗时', () => {
    const started = startThoughtTiming(createThoughtTimingState(), START_TIME_MS);
    const finished = finishThoughtTiming(started, END_TIME_MS);

    expect(finished.durationMs).toBe(EXPECTED_DURATION_MS);
    expect(finished.state.pendingStartedAtMs).toBeNull();
    expect(finished.state.completedDurationsMs).toEqual([EXPECTED_DURATION_MS]);
  });

  it('同一 Step 第二次结束不会再追加耗时', () => {
    const started = startThoughtTiming(createThoughtTimingState(), START_TIME_MS);
    const first = finishThoughtTiming(started, END_TIME_MS);
    const second = finishThoughtTiming(first.state, END_TIME_MS);

    expect(second.durationMs).toBeNull();
    expect(second.state.completedDurationsMs).toEqual([EXPECTED_DURATION_MS]);
  });

  it('清理时丢弃没有对应 assistant 消息的计时', () => {
    const started = startThoughtTiming(createThoughtTimingState(), START_TIME_MS);

    expect(clearThoughtTiming(started)).toEqual(createThoughtTimingState());
  });
});
