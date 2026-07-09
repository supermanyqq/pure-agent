import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSSEStream } from '../sse-parser.js';
import { SSEParseError } from '../errors.js';
import type { DeepSeekStreamChunk } from '../deepseek-types.js';

// ===== 辅助函数 =====

/** 将字符串一次性转换为 ReadableStream */
function stringToStream(s: string): ReadableStream {
  const encoder = new TextEncoder();
  const data = encoder.encode(s);
  return new ReadableStream({
    start(controller) {
      // 空数据不 enqueue，避免零长 chunk 触发 receivedBytes=true
      if (data.length > 0) {
        controller.enqueue(data);
      }
      controller.close();
    },
  });
}

/** 分块推入流，每段一个 Uint8Array chunk，模拟 TCP 拆包 */
function chunkedStream(parts: string[]): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

/** 构建最小合法的 SSE text-delta chunk JSON */
function makeChunkJson(content: string, id = 'test-id'): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'deepseek-chat',
    choices: [{ index: 0, delta: { content } }],
  });
}

/** 构建完整的 SSE frame: "data: <JSON>\n\n" */
function makeFrame(content: string): string {
  return `data: ${makeChunkJson(content)}\n\n`;
}

/** 收集 async generator 所有 yield 值 */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

// ===== 测试套件 =====

describe('parseSSEStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------- 1. 单帧 SSE text delta ----------
  it('parses a single SSE frame with text delta into correct chunk', async () => {
    const content = 'Hello, world!';
    const stream = stringToStream(makeFrame(content));
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe(content);
    expect(chunks[0].object).toBe('chat.completion.chunk');
  });

  // ---------- 2. [DONE] 标记停止流 ----------
  it('stops gracefully when [DONE] marker is received', async () => {
    const stream = stringToStream(makeFrame('first') + 'data: [DONE]\n\n');
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe('first');
  });

  // ---------- 3. 跨 chunk 边界（JSON 被 TCP 拆包）----------
  it('correctly parses JSON split across chunk boundaries', async () => {
    const fullJson = makeChunkJson('hello-boundary');
    const frame = `data: ${fullJson}\n\n`;
    const mid = Math.floor(frame.length / 2);

    const stream = chunkedStream([frame.slice(0, mid), frame.slice(mid)]);
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe('hello-boundary');
  });

  // ---------- 3b. 切在 JSON 字段值中间 ----------
  it('parses when chunk boundary splits inside a JSON field value', async () => {
    const json = makeChunkJson('split-middle');
    const frame = `data: ${json}\n\n`;
    const cutAt = frame.indexOf('split-middle') + 4;

    const stream = chunkedStream([frame.slice(0, cutAt), frame.slice(cutAt)]);
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe('split-middle');
  });

  // ---------- 4. 同一 TCP frame 中包含多个 SSE frame ----------
  it('yields all chunks when multiple SSE frames arrive in one TCP frame', async () => {
    const stream = stringToStream(
      makeFrame('chunk-a') + makeFrame('chunk-b') + makeFrame('chunk-c'),
    );
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(3);
    expect(chunks.map(c => c.choices[0].delta.content)).toEqual([
      'chunk-a',
      'chunk-b',
      'chunk-c',
    ]);
  });

  // ---------- 5. 畸形 JSON 被跳过，不崩溃 ----------
  it('skips malformed JSON gracefully without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stream = stringToStream(
      makeFrame('valid') + 'data: { this is not valid json }\n\n' + makeFrame('after'),
    );
    const chunks = await collect(parseSSEStream(stream));

    // 只有有效帧被产出
    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe('valid');
    expect(chunks[1].choices[0].delta.content).toBe('after');

    // 应记录跳过日志
    const skipWarns = warnSpy.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('Skipped malformed JSON'),
    );
    expect(skipWarns).toHaveLength(1);

    warnSpy.mockRestore();
  });

  // ---------- 6. 空流 ----------
  it('yields no chunks for an empty stream', async () => {
    const chunks = await collect(parseSSEStream(stringToStream('')));
    expect(chunks).toHaveLength(0);
  });

  // ---------- 7. 仅包含 [DONE] 的流 ----------
  it('yields no chunks when stream contains only [DONE]', async () => {
    // [DONE] 是合法的 SSE 结束标记，流正常结束不抛错
    const stream = stringToStream('data: [DONE]\n\n');
    const chunks = await collect(parseSSEStream(stream));
    expect(chunks).toHaveLength(0);
  });

  // ---------- 8. 收到数据但无有效 SSE frame ----------
  it('throws SSEParseError when stream has no valid SSE frames', async () => {
    // 非 SSE 文本
    const stream1 = stringToStream('not valid sse data at all');
    await expect(collect(parseSSEStream(stream1))).rejects.toThrow(SSEParseError);

    // 验证错误消息内容
    const stream2 = stringToStream('completely invalid');
    await expect(collect(parseSSEStream(stream2))).rejects.toThrow(
      /no valid SSE frames/i,
    );
  });

  // ---------- 9. 流末尾有不完整帧 ----------
  it('logs warning on incomplete frame at end of stream and exits cleanly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 有效帧在前（保证 yieldedCount > 0），残留垃圾在后
    const stream = stringToStream(makeFrame('complete') + 'data: {"unfinished');
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe('complete');

    // 应有 incomplete frame 警告
    const incompleteCalls = warnSpy.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('Incomplete frame'),
    );
    expect(incompleteCalls).toHaveLength(1);

    warnSpy.mockRestore();
  });

  // ---------- 10. 同一 frame 中多条 data: 行用 \n 拼接 ----------
  it('joins multiple data: lines in one frame with newline', async () => {
    const part1 = '{"id":"multi","object":"chat.completion.chunk","created":1,';
    const part2 = '"model":"test","choices":[{"index":0,"delta":{"content":"joined"}}]}';

    const frame = `data: ${part1}\ndata: ${part2}\n\n`;
    const chunks = await collect(parseSSEStream(stringToStream(frame)));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe('joined');
  });

  // ===== 额外测试 =====

  // --- 多帧跨多个 Uint8Array chunk ---
  it('handles multiple frames spread across multiple TCP chunks', async () => {
    const f1 = makeFrame('first');
    const f2 = makeFrame('second');
    const mid = Math.floor(f2.length / 2);

    const stream = chunkedStream([f1 + f2.slice(0, mid), f2.slice(mid)]);
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe('first');
    expect(chunks[1].choices[0].delta.content).toBe('second');
  });

  // --- 没有 data: 前缀的行被忽略 ---
  it('ignores lines without data: prefix within a frame', async () => {
    const stream = stringToStream(`:comment line\n${makeFrame('real')}`);
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe('real');
  });

  // --- reasoning_content delta ---
  it('parses chunk with reasoning_content delta', async () => {
    const json = JSON.stringify({
      id: 'r1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test',
      choices: [{ index: 0, delta: { reasoning_content: 'Let me think...' } }],
    });
    const chunks = await collect(parseSSEStream(stringToStream(`data: ${json}\n\n`)));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.reasoning_content).toBe('Let me think...');
  });

  // --- tool_calls delta ---
  it('parses chunk with tool_calls delta', async () => {
    const json = JSON.stringify({
      id: 't1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_abc',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"/tmp"}' },
              },
            ],
          },
        },
      ],
    });
    const chunks = await collect(parseSSEStream(stringToStream(`data: ${json}\n\n`)));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.tool_calls).toBeDefined();
    expect(chunks[0].choices[0].delta.tool_calls![0].function!.name).toBe('read_file');
  });

  // --- finish_reason 和 usage 信息 ---
  it('parses chunk with finish_reason and usage info', async () => {
    const json = JSON.stringify({
      id: 'final',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const chunks = await collect(parseSSEStream(stringToStream(`data: ${json}\n\n`)));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].finish_reason).toBe('stop');
    expect(chunks[0].usage?.total_tokens).toBe(15);
  });

  // --- 混合有效帧、[DONE] 和垃圾文本 ---
  it('yields valid frames and skips garbage text between frames', async () => {
    const stream = stringToStream(
      `garbage without prefix\n${makeFrame('hello')}data: [DONE]\n\nmore garbage`,
    );
    const chunks = await collect(parseSSEStream(stream));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe('hello');
  });

  // --- reader.releaseLock() 在异常路径被调用 ---
  it('releases reader lock even when an error occurs', async () => {
    const stream = chunkedStream(['not valid sse']);

    const originalGetReader = stream.getReader.bind(stream);
    let releaseCalled = false;
    stream.getReader = () => {
      const reader = originalGetReader();
      const originalRelease = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        releaseCalled = true;
        originalRelease();
      };
      return reader;
    };

    await expect(collect(parseSSEStream(stream))).rejects.toThrow();
    expect(releaseCalled).toBe(true);
  });

  // --- 仅空白字符的流 ---
  it('throws SSEParseError on whitespace-only stream', async () => {
    const stream = stringToStream('\n\n  \n\n');
    await expect(collect(parseSSEStream(stream))).rejects.toThrow(SSEParseError);
  });
});
