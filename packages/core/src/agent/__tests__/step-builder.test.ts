import { describe, it, expect, vi } from 'vitest';
import { StepBuilder, ContextWindowError } from '../step-builder.js';
import type { Message, ToolDefinition, AgentOptions, ContextManager, TrimResult } from '../../types/index.js';

function makeTrimResult(messages: Message[]): TrimResult {
  return {
    messages,
    removedTurns: 0,
    removedMessageCount: 0,
    summarized: false,
    estimatedTokens: 0,
    tokensSaved: 0,
    status: 'unchanged',
  };
}

function createMockContextManager(
  behavior?: 'passthrough' | 'throw',
): ContextManager {
  return {
    fitToWindow: vi.fn(async (msgs: Message[], _tools: ToolDefinition[]) => {
      if (behavior === 'throw') {
        throw new ContextWindowError('窗口超限', 200000, 128000);
      }
      return makeTrimResult(msgs);
    }),
    estimateTokens: vi.fn((msgs: Message[]) =>
      msgs.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0),
    ),
    getCompressionStats: vi.fn(() => ({
      compressionCount: 0,
      lastSavingsPercent: 100,
      ineffectiveCompressionCount: 0,
      lastCompressAborted: false,
      summaryInCooldown: false,
    })),
    reset: vi.fn(),
    updateModel: vi.fn(),
  };
}

function createTestTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'shell_exec',
        description: 'Execute a shell command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
  ];
}

function createTestOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return { model: 'deepseek-chat', maxSteps: 10, ...overrides };
}

const signal = new AbortController().signal;

describe('StepBuilder', () => {
  // ===== System Prompt 处理 =====

  it('应该保留 messages 中已有的 system 消息', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];

    const request = await builder.build(messages, [], createTestOptions(), signal);

    expect(request.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(cm.fitToWindow).toHaveBeenCalled();
  });

  it('当 messages 无 system 时，应该用 options.systemPrompt 插入', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];

    const request = await builder.build(
      messages,
      [],
      createTestOptions({ systemPrompt: 'You are helpful.' }),
      signal,
    );

    expect(request.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    // fitToWindow 应该收到含 system 的消息
    const fitCall = (cm.fitToWindow as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fitCall[0][0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('当两者都没有时，不添加 system 消息', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];

    const request = await builder.build(messages, [], createTestOptions(), signal);

    expect(request.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('messages[0] 是 system 且 options.systemPrompt 也设置了，优先用 messages 中的', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const messages: Message[] = [
      { role: 'system', content: 'Custom system' },
      { role: 'user', content: 'Hello' },
    ];

    const request = await builder.build(
      messages,
      [],
      createTestOptions({ systemPrompt: 'Default system' }),
      signal,
    );

    expect(request.messages[0]).toEqual({ role: 'system', content: 'Custom system' });
  });

  // ===== 工具序列化 =====

  it('tools 为空数组时，ChatRequest 不应包含 tools 字段', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);

    const request = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      [],
      createTestOptions(),
      signal,
    );

    expect(request.tools).toBeUndefined();
  });

  it('tools 应按名称字母排序', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const tools = createTestTools(); // shell_exec, read_file (注册顺序)

    const request = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      tools,
      createTestOptions(),
      signal,
    );

    expect(request.tools).toBeDefined();
    // 排序后：read_file 应在 shell_exec 前面
    expect(request.tools![0].function.name).toBe('read_file');
    expect(request.tools![1].function.name).toBe('shell_exec');
  });

  it('单个工具的 ToolDefinition 应正确传递', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const tools: ToolDefinition[] = [{
      type: 'function',
      function: {
        name: 'single_tool',
        description: 'A single tool',
        parameters: { type: 'object', properties: {} },
      },
    }];

    const request = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      tools,
      createTestOptions(),
      signal,
    );

    expect(request.tools).toHaveLength(1);
    expect(request.tools![0].function.name).toBe('single_tool');
  });

  // ===== fitToWindow 集成 =====

  it('应该在 build 时调用 contextManager.fitToWindow', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];

    await builder.build(messages, [], createTestOptions(), signal);

    expect(cm.fitToWindow).toHaveBeenCalledTimes(1);
  });

  it('fitToWindow 抛出 ContextWindowError 时应透传', async () => {
    const cm = createMockContextManager('throw');
    const builder = new StepBuilder(cm);

    await expect(
      builder.build(
        [{ role: 'user', content: 'Hello' }],
        [],
        createTestOptions(),
        signal,
      ),
    ).rejects.toThrow(ContextWindowError);
  });

  it('signal.aborted 时应在 fitToWindow 后抛出 AbortError', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const controller = new AbortController();
    controller.abort();

    await expect(
      builder.build(
        [{ role: 'user', content: 'Hello' }],
        [],
        createTestOptions(),
        controller.signal,
      ),
    ).rejects.toThrow('The operation was aborted');
  });

  // ===== 请求组装 =====

  it('应该设置 stream: true', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);

    const request = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      [],
      createTestOptions(),
      signal,
    );

    expect(request.stream).toBe(true);
  });

  it('temperature 为 0 时应正常传入', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);

    const request = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      [],
      createTestOptions({ temperature: 0 }),
      signal,
    );

    expect(request.temperature).toBe(0);
  });

  it('temperature 为 undefined 时不传入', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);

    const request = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      [],
      createTestOptions({ temperature: undefined }),
      signal,
    );

    expect(request.temperature).toBeUndefined();
  });

  it('maxTokens 为 undefined 时不传入', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);

    const request = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      [],
      createTestOptions({ maxTokens: undefined }),
      signal,
    );

    expect(request.maxTokens).toBeUndefined();
  });

  it('model 应来自 options.model', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);

    const request = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      [],
      createTestOptions({ model: 'deepseek-chat' }),
      signal,
    );

    expect(request.model).toBe('deepseek-chat');
  });

  // ===== Prompt Caching =====

  it('连续两次 build 调用，tools 顺序应相同（排序稳定性）', async () => {
    const cm = createMockContextManager();
    const builder = new StepBuilder(cm);
    const tools = createTestTools();

    const r1 = await builder.build(
      [{ role: 'user', content: 'Hello' }],
      tools,
      createTestOptions(),
      signal,
    );
    const r2 = await builder.build(
      [{ role: 'user', content: 'Hello again' }],
      tools,
      createTestOptions(),
      signal,
    );

    expect(r1.tools).toBeDefined();
    expect(r2.tools).toBeDefined();
    expect(r1.tools!.map(t => t.function.name)).toEqual(
      r2.tools!.map(t => t.function.name),
    );
  });
});
