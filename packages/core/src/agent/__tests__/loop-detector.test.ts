import { describe, it, expect, beforeEach } from 'vitest';
import { LoopDetector } from '../loop-detector.js';
import type { ToolCall } from '../../types/index.js';

function makeToolCall(name: string, args: string, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
}

function makeToolCalls(
  calls: Array<[string, string]>,
): ToolCall[] {
  return calls.map(([name, args], i) =>
    makeToolCall(name, args, `call_${i}`),
  );
}

describe('LoopDetector', () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  // ===== 基本检测 =====

  it('第一次调用不应判定为循环', () => {
    detector.addToolCalls(makeToolCalls([['read_file', '{"path":"a.txt"}']]));
    expect(detector.isLooping()).toBe(false);
  });

  it('连续 2 次相同调用不应判定为循环', () => {
    const calls = makeToolCalls([['read_file', '{"path":"a.txt"}']]);
    detector.addToolCalls(calls);
    detector.addToolCalls(calls);
    expect(detector.isLooping()).toBe(false);
  });

  it('连续 3 次相同调用应判定为循环', () => {
    const calls = makeToolCalls([['read_file', '{"path":"a.txt"}']]);
    detector.addToolCalls(calls);
    detector.addToolCalls(calls);
    detector.addToolCalls(calls);
    expect(detector.isLooping()).toBe(true);
  });

  it('第 2 次不同时应重置计数', () => {
    detector.addToolCalls(makeToolCalls([['read_file', '{"path":"a.txt"}']]));
    detector.addToolCalls(makeToolCalls([['shell_exec', '{"cmd":"ls"}']]));
    expect(detector.isLooping()).toBe(false);
  });

  it('第 3 次与第 2 次不同时应重置计数', () => {
    const same = makeToolCalls([['read_file', '{"path":"a.txt"}']]);
    const different = makeToolCalls([['shell_exec', '{"cmd":"ls"}']]);
    detector.addToolCalls(same);
    detector.addToolCalls(same);  // repeatCount = 2
    detector.addToolCalls(different);  // different → reset to 1
    expect(detector.isLooping()).toBe(false);
  });

  // ===== 比较逻辑 =====

  it('函数名不同时应判定为不同', () => {
    const a = makeToolCalls([['read_file', '{"path":"a.txt"}']]);
    const b = makeToolCalls([['shell_exec', '{"path":"a.txt"}']]);
    detector.addToolCalls(a);
    detector.addToolCalls(b);
    detector.addToolCalls(b);
    expect(detector.isLooping()).toBe(false); // b appeared twice, not thrice
  });

  it('arguments 不同时应判定为不同', () => {
    const a = makeToolCalls([['read_file', '{"path":"a.txt"}']]);
    const b = makeToolCalls([['read_file', '{"path":"b.txt"}']]);
    detector.addToolCalls(a);
    detector.addToolCalls(b);
    detector.addToolCalls(b);
    expect(detector.isLooping()).toBe(false);
  });

  it('数组长度不同时应判定为不同', () => {
    const single = makeToolCalls([['read_file', '{"path":"a.txt"}']]);
    const double = makeToolCalls([
      ['read_file', '{"path":"a.txt"}'],
      ['shell_exec', '{"cmd":"ls"}'],
    ]);
    detector.addToolCalls(single);
    detector.addToolCalls(double);
    detector.addToolCalls(double);
    expect(detector.isLooping()).toBe(false);
  });

  it('数组顺序不同时应判定为不同', () => {
    const a = [
      makeToolCall('read_file', '{"path":"a.txt"}', 'call_0'),
      makeToolCall('shell_exec', '{"cmd":"ls"}', 'call_1'),
    ];
    const b = [
      makeToolCall('shell_exec', '{"cmd":"ls"}', 'call_0'),
      makeToolCall('read_file', '{"path":"a.txt"}', 'call_1'),
    ];
    detector.addToolCalls(a);
    detector.addToolCalls(b);
    detector.addToolCalls(b);
    expect(detector.isLooping()).toBe(false);
  });

  // ===== reset =====

  it('reset 后应清除状态', () => {
    const calls = makeToolCalls([['read_file', '{"path":"a.txt"}']]);
    detector.addToolCalls(calls);
    detector.addToolCalls(calls);
    detector.reset();
    detector.addToolCalls(calls);
    detector.addToolCalls(calls);
    expect(detector.isLooping()).toBe(false); // 重置后从 1 开始
  });

  // ===== 边界 =====

  it('空 toolCalls 数组与空数组比较应相同', () => {
    detector.addToolCalls([]);
    detector.addToolCalls([]);
    detector.addToolCalls([]);
    expect(detector.isLooping()).toBe(true);
  });

  it('arguments 为空字符串时应正常比较', () => {
    const calls = makeToolCalls([['read_file', '']]);
    detector.addToolCalls(calls);
    detector.addToolCalls(calls);
    detector.addToolCalls(calls);
    expect(detector.isLooping()).toBe(true);
  });
});
