import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../loop.js';
import type {
  Message,
  ToolCall,
  ToolDefinition,
  AgentOptions,
  ChatProvider,
  ToolRegistry,
  ContextManager,
  AgentEventEmitter,
  StreamEvent,
} from '../../types/index.js';

// Re-export StreamEvent for mock usage (it comes from provider but defined here for test)
type MockStreamEvent = StreamEvent;

// ===== Mock 工厂 =====

function createMockProvider(
  responses: MockStreamEvent[][] = [],
): ChatProvider {
  let callCount = 0;
  return {
    streamMessage: async function* (params) {
      const events = responses[callCount] ?? [
        { type: 'done', finishReason: 'stop' },
      ];
      callCount++;
      for (const event of events) {
        if (params.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        yield event;
      }
    },
  };
}

function createMockRegistry(
  tools: ToolDefinition[] = [],
  executeImpl?: (name: string, args: Record<string, unknown>) => string,
): ToolRegistry {
  return {
    getDefinitions: () => tools,
    execute: async (name: string, args: Record<string, unknown>) => {
      if (executeImpl) return executeImpl(name, args);
      return JSON.stringify({ tool: name, args });
    },
  };
}

function createMockContextManager(): ContextManager {
  return {
    fitToWindow: async (msgs: Message[]) => ({
      messages: msgs,
      removedTurns: 0,
      removedMessageCount: 0,
      summarized: false,
      estimatedTokens: 0,
      tokensSaved: 0,
      status: 'unchanged' as const,
    }),
    estimateTokens: (msgs: Message[]) =>
      msgs.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0),
    getCompressionStats: () => ({
      compressionCount: 0,
      lastSavingsPercent: 100,
      ineffectiveCompressionCount: 0,
      lastCompressAborted: false,
      summaryInCooldown: false,
    }),
    reset: () => {},
    updateModel: () => {},
  };
}

function createMockEvents(): AgentEventEmitter & { events: Array<{ type: string; payload?: unknown }> } {
  const events: Array<{ type: string; payload?: unknown }> = [];
  return {
    events,
    emit(type: string, payload?: unknown) {
      events.push({ type, payload });
    },
  };
}

// ===== 测试数据 =====

function makeMessagesWithUser(content: string): Message[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content },
  ];
}

function makeOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return { model: 'deepseek-chat', maxSteps: 5, ...overrides };
}

// ===== 测试 =====

describe('AgentLoop', () => {
  let events: ReturnType<typeof createMockEvents>;

  beforeEach(() => {
    events = createMockEvents();
  });

  // ===== 纯文本回复 =====

  it('纯文本回复：应该返回 completed 状态并保存 assistant 消息', async () => {
    const provider = createMockProvider([
      [
        { type: 'text', content: 'Hello' },
        { type: 'text', content: ' world!' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const registry = createMockRegistry();
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const messages = makeMessagesWithUser('Say hi');
    const result = await loop.run(messages, makeOptions(), new AbortController().signal);

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    expect(result.messages).toHaveLength(3); // system + user + assistant
    expect(result.messages[2]).toMatchObject({
      role: 'assistant',
      content: 'Hello world!',
    });
  });

  // ===== tool_calls → 文本回复 =====

  it('单次 tool_calls 后文本回复', async () => {
    const provider = createMockProvider([
      // Step 1: tool_calls
      [
        { type: 'tool_call_start', id: 'call_1', name: 'read_file' },
        { type: 'tool_call_delta', id: 'call_1', arguments: '{"path":"package.json"}' },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      // Step 2: text response
      [
        { type: 'text', content: 'The project is pure-agent.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const registry = createMockRegistry([], (name, args) => {
      if (name === 'read_file' && args.path === 'package.json') {
        return '{"name":"pure-agent"}';
      }
      return '{}';
    });
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const messages = makeMessagesWithUser('Read package.json');
    const result = await loop.run(messages, makeOptions(), new AbortController().signal);

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(2);

    // 消息序列：system, user, assistant(tool_calls), tool, assistant(text)
    expect(result.messages).toHaveLength(5);
    const msg2 = result.messages[2] as { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] };
    const msg3 = result.messages[3] as { role: 'tool'; content: string; toolCallId: string };
    const msg4 = result.messages[4] as { role: 'assistant'; content: string | null };
    expect(msg2.role).toBe('assistant');
    expect(msg2.toolCalls).toBeDefined();
    expect(msg3.role).toBe('tool');
    expect(msg3.toolCallId).toBe('call_1');
    expect(msg4.role).toBe('assistant');
    expect(result.messages[4].content).toBe('The project is pure-agent.');
  });

  // ===== maxSteps 触发 =====

  it('maxSteps 到达时应终止', async () => {
    // Provider 始终返回 tool_calls，触发循环
    const toolCallEvents: MockStreamEvent[] = [
      { type: 'tool_call_start', id: 'call_1', name: 'read_file' },
      { type: 'tool_call_delta', id: 'call_1', arguments: '{"path":"a.txt"}' },
      { type: 'done', finishReason: 'tool_calls' },
    ];
    const provider = createMockProvider([
      toolCallEvents, toolCallEvents, toolCallEvents,
    ]);
    const registry = createMockRegistry([], () => 'content');
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Read all files'),
      makeOptions({ maxSteps: 2 }),
      new AbortController().signal,
    );

    expect(result.status).toBe('max_steps');
    expect(result.steps).toBe(2);
  });

  // ===== 死循环检测 =====

  it('连续 3 次相同 tool_calls 应触发死循环检测', async () => {
    const sameEvents: MockStreamEvent[] = [
      { type: 'tool_call_start', id: 'call_1', name: 'read_file' },
      { type: 'tool_call_delta', id: 'call_1', arguments: '{"path":"a.txt"}' },
      { type: 'done', finishReason: 'tool_calls' },
    ];
    const provider = createMockProvider([
      sameEvents, sameEvents, sameEvents, sameEvents,
    ]);
    const registry = createMockRegistry([], () => 'content');
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Read a.txt'),
      makeOptions({ maxSteps: 10 }),
      new AbortController().signal,
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('LOOP_DETECTED');
  });

  // ===== Abort 中断 =====

  it('abort 信号应在开始前生效（检查点 1）', async () => {
    const provider = createMockProvider([]);
    const registry = createMockRegistry();
    const cm = createMockContextManager();
    const controller = new AbortController();
    controller.abort();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      controller.signal,
    );

    expect(result.status).toBe('aborted');
    expect(result.steps).toBe(0);
  });

  it('abort 应在流式迭代中生效（检查点 2）', async () => {
    // Provider 在 yield 第一个事件后检查 abort
    const provider = createMockProvider([
      [
        { type: 'text', content: 'partial response...' },
        { type: 'text', content: 'more...' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const registry = createMockRegistry();
    const cm = createMockContextManager();
    const controller = new AbortController();

    // 在 provider 的 streamMessage 中使用 signal
    const loop = new AgentLoop(provider, registry, cm, events);

    // 立即 abort
    controller.abort();
    const result = await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      controller.signal,
    );

    expect(result.status).toBe('aborted');
  });

  // ===== Provider 异常 =====

  it('Provider 抛出非 AbortError 的异常时应返回 error', async () => {
    const provider: ChatProvider = {
      streamMessage: async function* () {
        throw new Error('Network failure');
      },
    };
    const registry = createMockRegistry();
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      new AbortController().signal,
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Network failure');
  });

  // ===== 文本 + tool_calls 混合 =====

  it('流式响应同时包含文本和 tool_calls 应正确处理', async () => {
    const provider = createMockProvider([
      [
        { type: 'text', content: 'Let me read that file.' },
        { type: 'tool_call_start', id: 'call_1', name: 'read_file' },
        { type: 'tool_call_delta', id: 'call_1', arguments: '{"path":"a.txt"}' },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text', content: 'File content is: hello' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const registry = createMockRegistry([], () => 'file content');
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Read a.txt'),
      makeOptions(),
      new AbortController().signal,
    );

    expect(result.status).toBe('completed');
    // 验证 assistant 消息同时包含 text 和 tool_calls
    const assistantWithTools = result.messages[2] as { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] };
    expect(assistantWithTools.role).toBe('assistant');
    expect(assistantWithTools.content).toBe('Let me read that file.');
    expect(assistantWithTools.toolCalls).toBeDefined();
    expect(assistantWithTools.toolCalls).toHaveLength(1);
  });

  // ===== 事件发射验证 =====

  it('应该按顺序发射关键生命周期事件', async () => {
    const provider = createMockProvider([
      [
        { type: 'text', content: 'Hi!' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const registry = createMockRegistry();
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      new AbortController().signal,
    );

    const eventTypes = events.events.map(e => e.type);
    expect(eventTypes).toContain('agent:turn:start');
    expect(eventTypes).toContain('agent:step:start');
    expect(eventTypes).toContain('agent:thinking');
    expect(eventTypes).toContain('agent:stream:delta');
    expect(eventTypes).toContain('agent:response');
    expect(eventTypes).toContain('agent:turn:end');

    // 验证事件顺序：turn:start → step:start → thinking → stream:delta → response → turn:end
    const turnStartIdx = eventTypes.indexOf('agent:turn:start');
    const stepStartIdx = eventTypes.indexOf('agent:step:start');
    const thinkingIdx = eventTypes.indexOf('agent:thinking');
    const deltaIdx = eventTypes.indexOf('agent:stream:delta');
    const responseIdx = eventTypes.indexOf('agent:response');
    const turnEndIdx = eventTypes.indexOf('agent:turn:end');

    expect(turnStartIdx).toBeLessThan(stepStartIdx);
    expect(stepStartIdx).toBeLessThan(thinkingIdx);
    expect(thinkingIdx).toBeLessThan(deltaIdx);
    expect(deltaIdx).toBeLessThan(responseIdx);
    expect(responseIdx).toBeLessThan(turnEndIdx);
  });

  it('abort 应发射 agent:abort 事件', async () => {
    const provider = createMockProvider([]);
    const registry = createMockRegistry();
    const cm = createMockContextManager();
    const controller = new AbortController();
    controller.abort();

    const loop = new AgentLoop(provider, registry, cm, events);
    await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      controller.signal,
    );

    expect(events.events.map(e => e.type)).toContain('agent:abort');
  });

  // ===== finishReason 边界 =====

  it('finishReason 为 length 时应保存部分文本并返回 completed', async () => {
    const provider = createMockProvider([
      [
        { type: 'text', content: 'partial response truncated by token limit...' },
        { type: 'done', finishReason: 'length' },
      ],
    ]);
    const registry = createMockRegistry();
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      new AbortController().signal,
    );

    expect(result.status).toBe('completed');
    const assistantMsg = result.messages[result.messages.length - 1];
    expect(assistantMsg.role).toBe('assistant');
    expect((assistantMsg as { content: string }).content).toContain('partial response');
  });

  it('finishReason 为 tool_calls 但无实际 tool_call 事件时应保存文本并完成', async () => {
    const provider = createMockProvider([
      [
        { type: 'text', content: 'No tool needed after all.' },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ]);
    const registry = createMockRegistry();
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      new AbortController().signal,
    );

    expect(result.status).toBe('completed');
    const assistantMsg = result.messages[result.messages.length - 1];
    expect(assistantMsg.role).toBe('assistant');
    expect((assistantMsg as { content: string }).content).toBe('No tool needed after all.');
  });

  // ===== StepBuilder 异常 =====

  it('stepBuilder 抛出异常时应返回 error 状态', async () => {
    const provider = createMockProvider([]);
    const registry = createMockRegistry();
    const cm: ContextManager = {
      fitToWindow: async () => { throw new Error('Context window overflow'); },
      estimateTokens: () => 0,
      getCompressionStats: () => ({
        compressionCount: 0,
        lastSavingsPercent: 100,
        ineffectiveCompressionCount: 0,
        lastCompressAborted: false,
        summaryInCooldown: false,
      }),
      reset: () => {},
      updateModel: () => {},
    };

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      new AbortController().signal,
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Context window overflow');
  });

  // ===== 工具调用事件验证 =====

  it('工具调用应发射 agent:tool_calls 和 agent:executing 和 agent:tool_result 事件', async () => {
    const provider = createMockProvider([
      [
        { type: 'tool_call_start', id: 'call_1', name: 'read_file' },
        { type: 'tool_call_delta', id: 'call_1', arguments: '{"path":"a.txt"}' },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text', content: 'Done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const registry = createMockRegistry([], () => 'file content');
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    await loop.run(
      makeMessagesWithUser('read file'),
      makeOptions(),
      new AbortController().signal,
    );

    const eventTypes = events.events.map(e => e.type);
    expect(eventTypes).toContain('agent:tool_calls');
    expect(eventTypes).toContain('agent:executing');
    expect(eventTypes).toContain('agent:tool_result');
  });

  // ===== 多步不同工具不触发死循环 =====

  it('连续不同工具调用不应触发死循环', async () => {
    const step1: StreamEvent[] = [
      { type: 'tool_call_start', id: 'c1', name: 'read_file' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"path":"a.txt"}' },
      { type: 'done', finishReason: 'tool_calls' },
    ];
    const step2: StreamEvent[] = [
      { type: 'tool_call_start', id: 'c2', name: 'grep' },
      { type: 'tool_call_delta', id: 'c2', arguments: '{"pattern":"TODO"}' },
      { type: 'done', finishReason: 'tool_calls' },
    ];
    const step3: StreamEvent[] = [
      { type: 'text', content: 'All done.' },
      { type: 'done', finishReason: 'stop' },
    ];
    const provider = createMockProvider([step1, step2, step3]);
    const registry = createMockRegistry([], () => 'result');
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('do tasks'),
      makeOptions(),
      new AbortController().signal,
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(3);
  });

  // ===== Provider 流中间异常 =====

  it('Provider 在流式迭代中间抛出异常应返回 error', async () => {
    const provider: ChatProvider = {
      streamMessage: async function* () {
        yield { type: 'text', content: 'partial...' };
        throw new Error('Connection lost mid-stream');
      },
    };
    const registry = createMockRegistry();
    const cm = createMockContextManager();

    const loop = new AgentLoop(provider, registry, cm, events);
    const result = await loop.run(
      makeMessagesWithUser('Hello'),
      makeOptions(),
      new AbortController().signal,
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Connection lost mid-stream');
  });
});
