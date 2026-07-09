import { describe, it, expect } from 'vitest';
import { executeAll } from '../tool-executor.js';
import type { ToolCall, ToolRegistry } from '../../types/index.js';

function makeToolCall(
  name: string,
  args: string,
  id = 'call_1',
): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function createMockRegistry(
  handlers: Record<string, (args: Record<string, unknown>) => string | Promise<string>>,
): ToolRegistry {
  return {
    getDefinitions: () => [],
    execute: async (name: string, args: Record<string, unknown>) => {
      const handler = handlers[name];
      if (!handler) return `Error: Tool "${name}" not found.`;
      return handler(args);
    },
    register: () => {},
    unregister: () => {},
  };
}

describe('executeAll', () => {
  // ===== 基本执行 =====

  it('单个工具调用应正常执行', async () => {
    const registry = createMockRegistry({
      read_file: () => 'file content',
    });
    const results = await executeAll(
      [makeToolCall('read_file', '{"path":"a.txt"}')],
      registry,
      new AbortController().signal,
    );
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe('call_1');
    expect(results[0].content).toBe('file content');
    expect(results[0].error).toBeUndefined();
  });

  it('应该并行执行多个工具调用', async () => {
    const startOrder: string[] = [];
    const registry = createMockRegistry({
      tool_a: async () => {
        startOrder.push('a');
        await new Promise(r => setTimeout(r, 30));
        return 'a_result';
      },
      tool_b: async () => {
        startOrder.push('b');
        await new Promise(r => setTimeout(r, 10));
        return 'b_result';
      },
    });

    const results = await executeAll(
      [
        makeToolCall('tool_a', '{}', 'call_a'),
        makeToolCall('tool_b', '{}', 'call_b'),
      ],
      registry,
      new AbortController().signal,
    );

    // 两个工具几乎同时开始（b 可能先于 a 开始，取决于 event loop）
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('a_result');
    expect(results[1].content).toBe('b_result');
    // 结果顺序应保持输入顺序
    expect(results[0].toolCallId).toBe('call_a');
    expect(results[1].toolCallId).toBe('call_b');
  });

  // ===== 参数解析 =====

  it('应该正确解析 JSON arguments', async () => {
    let receivedArgs: Record<string, unknown> = {};
    const registry = createMockRegistry({
      test: (args) => {
        receivedArgs = args;
        return 'ok';
      },
    });
    await executeAll(
      [makeToolCall('test', '{"path":"a.txt","mode":"read"}')],
      registry,
      new AbortController().signal,
    );
    expect(receivedArgs).toEqual({ path: 'a.txt', mode: 'read' });
  });

  it('arguments 为空字符串时返回解析错误', async () => {
    const registry = createMockRegistry({});
    const results = await executeAll(
      [makeToolCall('test', '')],
      registry,
      new AbortController().signal,
    );
    expect(results[0].error).toContain('Invalid JSON arguments');
    expect(results[0].content).toBe('');
  });

  it('arguments 为非法 JSON 时返回解析错误', async () => {
    const registry = createMockRegistry({});
    const results = await executeAll(
      [makeToolCall('test', '{invalid}')],
      registry,
      new AbortController().signal,
    );
    expect(results[0].error).toContain('Invalid JSON arguments');
  });

  it('arguments 包含嵌套对象和数组时应正确解析', async () => {
    let receivedArgs: Record<string, unknown> = {};
    const registry = createMockRegistry({
      test: (args) => { receivedArgs = args; return 'ok'; },
    });
    await executeAll(
      [makeToolCall('test', '{"nested":{"key":"val"},"items":[1,2,3]}')],
      registry,
      new AbortController().signal,
    );
    expect(receivedArgs).toEqual({ nested: { key: 'val' }, items: [1, 2, 3] });
  });

  // ===== 错误隔离 =====

  it('一个工具失败不应影响另一个工具', async () => {
    const registry = createMockRegistry({
      succeed: () => 'success',
      fail: () => { throw new Error('boom'); },
    });
    const results = await executeAll(
      [
        makeToolCall('succeed', '{}', 'call_ok'),
        makeToolCall('fail', '{}', 'call_fail'),
      ],
      registry,
      new AbortController().signal,
    );
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('success');
    expect(results[0].error).toBeUndefined();
    expect(results[1].content).toBe('');
    expect(results[1].error).toBe('boom');
  });

  it('工具抛出 Error 时应返回 error 字段', async () => {
    const registry = createMockRegistry({
      fail: () => { throw new Error('something went wrong'); },
    });
    const results = await executeAll(
      [makeToolCall('fail', '{}')],
      registry,
      new AbortController().signal,
    );
    expect(results[0].error).toBe('something went wrong');
  });

  it('工具抛出非 Error 对象时应捕获', async () => {
    const registry = createMockRegistry({
      fail: () => { throw 'string error'; },
    });
    const results = await executeAll(
      [makeToolCall('fail', '{}')],
      registry,
      new AbortController().signal,
    );
    expect(results[0].error).toBe('string error');
  });

  // ===== Abort =====

  it('signal.aborted 时应返回 aborted 结果', async () => {
    const registry = createMockRegistry({
      test: () => 'should not be called',
    });
    const controller = new AbortController();
    controller.abort();

    const results = await executeAll(
      [makeToolCall('test', '{}')],
      registry,
      controller.signal,
    );
    expect(results[0].error).toBe('Aborted by user');
    expect(results[0].content).toBe('');
  });

  // ===== 空输入 =====

  it('toolCalls 为空数组时应返回空数组', async () => {
    const registry = createMockRegistry({});
    const results = await executeAll([], registry, new AbortController().signal);
    expect(results).toHaveLength(0);
  });

  // ===== 工具不存在 =====

  it('工具不存在时应返回错误', async () => {
    const registry = createMockRegistry({});
    const results = await executeAll(
      [makeToolCall('unknown_tool', '{}')],
      registry,
      new AbortController().signal,
    );
    expect(results[0].content).toContain('Tool "unknown_tool" not found');
  });
});
