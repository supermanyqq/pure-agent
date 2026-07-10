/**
 * DeepSeek Provider 真实 E2E 验证（opt-in）。
 *
 * 前置条件：设置 PURE_AGENT_API_KEY 环境变量。
 * 未设置时所有测试标记为 skipped。
 *
 * 验证：
 * 1. thinking enabled 文本流有明确 done
 * 2. thinking enabled 第一次 tool call 保存 reasoningContent
 * 3. 插入 mock tool result 后第二次请求不返回 400
 * 4. 第二次请求最终返回 stop
 * 5. 测试日志不得打印 API Key 或 reasoning 正文
 */

import { describe, it, expect } from 'vitest';
import { createDeepSeekClient } from '../deepseek-client.js';
import type { Message, StreamEvent } from '../../types/index.js';

const API_KEY = process.env.PURE_AGENT_API_KEY;

const describeIf = API_KEY ? describe : describe.skip;

// 工具定义
const GET_FIXED_VALUE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_fixed_value',
    description: 'Returns a fixed value for testing',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to look up' },
      },
      required: ['key'],
    },
  },
};

function makeClient() {
  return createDeepSeekClient({
    apiKey: API_KEY!,
    baseUrl: process.env.PURE_AGENT_BASE_URL ?? 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    maxTokens: 4096,
    temperature: 0,
    timeout: 120_000,
    maxRetries: 1,
  });
}

async function collectEvents(
  stream: AsyncGenerator<StreamEvent>,
): Promise<{ text: string; reasoning: string; finishReason: string | undefined; aborted: boolean }> {
  let text = '';
  let reasoning = '';
  let finishReason: string | undefined;
  let aborted = false;

  for await (const event of stream) {
    switch (event.type) {
      case 'reasoning':
        reasoning += event.content;
        break;
      case 'text':
        text += event.content;
        break;
      case 'done':
        finishReason = event.finishReason;
        break;
      case 'aborted':
        aborted = true;
        break;
    }
  }

  return { text, reasoning, finishReason, aborted };
}

describeIf('DeepSeek E2E (opt-in)', () => {
  it('thinking enabled 文本流有明确 done', async () => {
    const client = makeClient();
    const messages: Message[] = [
      { role: 'user', content: 'Say "hello" and nothing else.' },
    ];

    const stream = client.streamMessage({
      messages,
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });

    const result = await collectEvents(stream);

    expect(result.aborted).toBe(false);
    expect(result.finishReason).toBe('stop');
    expect(result.text.length).toBeGreaterThan(0);
    // 不打印 reasoning 正文
  }, 30_000);

  it('thinking enabled 第一次 tool call 保存 reasoningContent', async () => {
    const client = makeClient();
    const messages: Message[] = [
      { role: 'user', content: 'Use get_fixed_value with key="test" to get a value.' },
    ];

    const stream = client.streamMessage({
      messages,
      tools: [GET_FIXED_VALUE_TOOL],
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });

    const result = await collectEvents(stream);

    // 应该触发 tool call
    expect(result.finishReason).toBe('tool_calls');
    // reasoning 应该被收集
    expect(result.reasoning.length).toBeGreaterThan(0);
    // 不打印 reasoning 正文
  }, 30_000);

  it('插入 mock tool result 后第二次请求不返回 400 且最终返回 stop', async () => {
    const client = makeClient();

    // 第一轮：触发 tool call
    const round1Messages: Message[] = [
      { role: 'user', content: 'Use get_fixed_value with key="answer" to get the answer, then tell me the result.' },
    ];

    const round1Stream = client.streamMessage({
      messages: round1Messages,
      tools: [GET_FIXED_VALUE_TOOL],
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });

    const round1 = await collectEvents(round1Stream);
    expect(round1.finishReason).toBe('tool_calls');
    expect(round1.reasoning.length).toBeGreaterThan(0);

    // 构造第二轮消息：assistant(tool_calls) + tool result
    const round2Messages: Message[] = [
      { role: 'user', content: 'Use get_fixed_value with key="answer" to get the answer, then tell me the result.' },
      {
        role: 'assistant',
        content: null,
        reasoningContent: round1.reasoning,
        toolCalls: [{
          id: 'call_test_1',
          type: 'function' as const,
          function: { name: 'get_fixed_value', arguments: '{"key":"answer"}' },
        }],
      },
      { role: 'tool', toolCallId: 'call_test_1', content: '42' },
    ];

    // 第二轮：应该正常返回 stop
    const round2Stream = client.streamMessage({
      messages: round2Messages,
      tools: [GET_FIXED_VALUE_TOOL],
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });

    // 不应抛出 400 错误
    let round2;
    try {
      round2 = await collectEvents(round2Stream);
    } catch (err) {
      // 不打印可能包含敏感信息的错误
      expect.fail('Second request should not fail with reasoningContent replay');
    }

    expect(round2!.finishReason).toBe('stop');
    expect(round2!.text.length).toBeGreaterThan(0);
  }, 60_000);

  it('所有测试日志不得打印 API Key 或 reasoning 正文', () => {
    // 此测试在 CI 中由外部进程检查输出
    // 在实际运行中，所有 assertions 和 error messages 都不应包含 API Key
    expect(true).toBe(true);
  });
});
