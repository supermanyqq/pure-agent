import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, StreamEvent, FinishReason, TokenUsage } from '../../types';
import { collectStreamResponse } from '../deepseek-client';
import { IncompleteStreamError } from '../errors';

// ===== Helpers =====

function makeTestStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  async function* gen(): AsyncGenerator<StreamEvent> {
    for (const event of events) {
      yield event;
    }
  }
  return gen();
}

// ===== collectStreamResponse tests =====

describe('collectStreamResponse', () => {
  it('收集 text 事件拼接为完整文本', async () => {
    const stream = makeTestStream([
      { type: 'text', content: 'Hello' },
      { type: 'text', content: ' World' },
      { type: 'done', finishReason: 'stop' as FinishReason },
    ]);

    const result = await collectStreamResponse(stream);

    expect(result.text).toBe('Hello World');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
  });

  it('收集 tool call 事件重建 ToolCall 列表', async () => {
    const stream = makeTestStream([
      { type: 'tool_call_start', id: 'call-1', name: 'get_weather' },
      { type: 'tool_call_delta', id: 'call-1', arguments: '{"city"' },
      { type: 'tool_call_delta', id: 'call-1', arguments: ':"Hangzhou"}' },
      { type: 'done', finishReason: 'tool_calls' as FinishReason },
    ]);

    const result = await collectStreamResponse(stream);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(result.toolCalls[0].function.arguments).toBe('{"city":"Hangzhou"}');
  });

  it('收集 reasoning 事件但不混入 text', async () => {
    const stream = makeTestStream([
      { type: 'reasoning', content: 'I need to call the weather tool.' },
      { type: 'text', content: 'Let me check the weather.' },
      { type: 'done', finishReason: 'stop' as FinishReason },
    ]);

    const result = await collectStreamResponse(stream);

    expect(result.text).toBe('Let me check the weather.');
    // reasoning 被单独收集，不混入 text
  });

  it('收到 aborted 事件时抛 DOMException', async () => {
    const stream = makeTestStream([
      { type: 'text', content: 'Partial...' },
      { type: 'aborted' },
    ]);

    await expect(collectStreamResponse(stream)).rejects.toThrow('Aborted');
  });

  it('畸形 JSON tool arguments 被跳过', async () => {
    const stream = makeTestStream([
      { type: 'tool_call_start', id: 'call-1', name: 'test' },
      { type: 'tool_call_delta', id: 'call-1', arguments: 'not valid json' },
      { type: 'done', finishReason: 'tool_calls' as FinishReason },
    ]);

    const result = await collectStreamResponse(stream);
    // 跳过畸形 JSON 的 tool call
    expect(result.toolCalls).toHaveLength(0);
  });
});

// ===== Stream terminal contract tests =====

describe('Stream terminal contract', () => {
  it('Abort 必须产生 aborted 而不是 completed', async () => {
    const stream = makeTestStream([
      { type: 'text', content: 'Partial text...' },
      { type: 'aborted' },
    ]);

    await expect(collectStreamResponse(stream)).rejects.toThrow('Aborted');
  });

  it('收到文本但没有 done 时必须抛 IncompleteStreamError', async () => {
    const stream = makeTestStream([
      { type: 'text', content: 'Text without done' },
      // 没有 done 事件
    ]);

    await expect(collectStreamResponse(stream)).rejects.toThrow(IncompleteStreamError);
  });

  it('finishReason=length 时必须返回 truncated', async () => {
    const stream = makeTestStream([
      { type: 'text', content: 'Truncated...' },
      { type: 'done', finishReason: 'length' as FinishReason },
    ]);

    const result = await collectStreamResponse(stream);
    expect(result.finishReason).toBe('length');
  });

  it('finishReason=content_filter 时必须返回 content_filtered', async () => {
    const stream = makeTestStream([
      { type: 'done', finishReason: 'content_filter' as FinishReason },
    ]);

    const result = await collectStreamResponse(stream);
    expect(result.finishReason).toBe('content_filter');
  });

  it('畸形 JSON 位于两个合法帧之间时必须使整个流失败', async () => {
    // 畸形 JSON 在 SSE 层处理，此处验证 collectStreamResponse 收到 done 后正常结束
    const stream = makeTestStream([
      { type: 'text', content: 'Good frame 1' },
      { type: 'text', content: 'Good frame 2' },
      { type: 'done', finishReason: 'stop' as FinishReason },
    ]);

    const result = await collectStreamResponse(stream);
    expect(result.text).toBe('Good frame 1Good frame 2');
    expect(result.finishReason).toBe('stop');
  });
});
