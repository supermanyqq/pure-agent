import { describe, it, expect, beforeEach } from 'vitest';
import { ToolCallAccumulator } from '../tool-call-accumulator.js';

describe('ToolCallAccumulator', () => {
  let acc: ToolCallAccumulator;

  beforeEach(() => {
    acc = new ToolCallAccumulator();
  });

  // ===== 基本功能 =====

  it('单个 tool_call_start + 单个 tool_call_delta 应产生完整 ToolCall', () => {
    acc.startToolCall('call_1', 'read_file');
    acc.appendArguments('call_1', '{"path":"package.json"}');

    const result = acc.getToolCalls();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('call_1');
    expect(result[0].type).toBe('function');
    expect(result[0].function.name).toBe('read_file');
    expect(result[0].function.arguments).toBe('{"path":"package.json"}');
  });

  it('多个 arguments 片段应拼接', () => {
    acc.startToolCall('call_1', 'read_file');
    acc.appendArguments('call_1', '{"path":"');
    acc.appendArguments('call_1', 'package.json"');
    acc.appendArguments('call_1', '}');

    const result = acc.getToolCalls();
    expect(result).toHaveLength(1);
    expect(result[0].function.arguments).toBe('{"path":"package.json"}');
  });

  it('多个 ToolCall 应按插入顺序排列', () => {
    acc.startToolCall('call_0', 'tool_a');
    acc.appendArguments('call_0', '{}');
    acc.startToolCall('call_1', 'tool_b');
    acc.appendArguments('call_1', '{}');

    const result = acc.getToolCalls();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('call_0');
    expect(result[0].function.name).toBe('tool_a');
    expect(result[1].id).toBe('call_1');
    expect(result[1].function.name).toBe('tool_b');
  });

  // ===== 边界情况 =====

  it('没有收到任何事件时应返回空数组', () => {
    expect(acc.getToolCalls()).toHaveLength(0);
  });

  it('收到 tool_call_delta 但未收到对应的 tool_call_start 时不应崩溃', () => {
    acc.appendArguments('unknown_id', 'some args');
    expect(acc.getToolCalls()).toHaveLength(0);
  });

  it('重复的 tool_call_start 不应创建重复条目', () => {
    acc.startToolCall('call_1', 'read_file');
    acc.startToolCall('call_1', 'different_name'); // 同一 id 再次 start

    const result = acc.getToolCalls();
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe('read_file'); // 保留第一次的 name
  });

  it('空字符串 arguments 片段应安全拼接', () => {
    acc.startToolCall('call_1', 'test');
    acc.appendArguments('call_1', '');
    acc.appendArguments('call_1', 'a');

    const result = acc.getToolCalls();
    expect(result[0].function.arguments).toBe('a');
  });

  it('交叉到达的多个 ToolCall 事件应正确处理', () => {
    // 模拟真实的交叉到达场景
    acc.startToolCall('call_0', 'read_file');
    acc.appendArguments('call_0', '{"path":"a.txt"}');
    acc.startToolCall('call_1', 'shell_exec');
    acc.appendArguments('call_1', '{"cmd":"ls"}');
    acc.appendArguments('call_0', ''); // 空片段

    const result = acc.getToolCalls();
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe('read_file');
    expect(result[0].function.arguments).toBe('{"path":"a.txt"}');
    expect(result[1].function.name).toBe('shell_exec');
    expect(result[1].function.arguments).toBe('{"cmd":"ls"}');
  });
});
