import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSSEStream, type SSEEvent } from '../sse-parser.js';
import { SSEParseError } from '../errors.js';

// ===== 辅助函数 =====

/** 将字符串一次性转换为 ReadableStream */
function stringToStream(s: string): ReadableStream {
  const encoder = new TextEncoder();
  const data = encoder.encode(s);
  return new ReadableStream({
    start(controller) {
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

  // ---------- 1. 单帧 SSE ----------
  it('解析单个 SSE 帧', async () => {
    const stream = stringToStream('data: {"x":1}\n\n');
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"x":1}');
  });

  // ---------- 2. [DONE] 标记跳过 ----------
  it('[DONE] 标记不产出事件', async () => {
    const stream = stringToStream('data: {"x":1}\n\ndata: [DONE]\n\n');
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"x":1}');
  });

  // ---------- 3. 跨 chunk 边界 ----------
  it('正确处理跨 chunk 边界拆分', async () => {
    const frame = 'data: {"hello":"world"}\n\n';
    const mid = Math.floor(frame.length / 2);

    const stream = chunkedStream([frame.slice(0, mid), frame.slice(mid)]);
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"hello":"world"}');
  });

  // ---------- 4. 同一 TCP frame 包含多个 SSE frame ----------
  it('同一 chunk 中多个帧分别产出', async () => {
    const stream = stringToStream(
      'data: a\n\ndata: b\n\ndata: c\n\n',
    );
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(3);
    expect(events.map(e => e.data)).toEqual(['a', 'b', 'c']);
  });

  // ---------- 5. 空流 ----------
  it('空流不产出事件', async () => {
    const events = await collect(parseSSEStream(stringToStream('')));
    expect(events).toHaveLength(0);
  });

  // ---------- 6. 仅包含 [DONE] ----------
  it('仅包含 [DONE] 时不产出事件', async () => {
    const stream = stringToStream('data: [DONE]\n\n');
    const events = await collect(parseSSEStream(stream));
    expect(events).toHaveLength(0);
  });

  // ---------- 7. 无效 SSE ----------
  it('无有效 SSE 帧时抛出 SSEParseError', async () => {
    const stream = stringToStream('not valid sse data at all');
    await expect(collect(parseSSEStream(stream))).rejects.toThrow(SSEParseError);
  });

  // ---------- 8. 多条 data 行拼接 ----------
  it('多条 data 行按换行拼接', async () => {
    const frame = 'data: first\ndata: second\n\n';
    const events = await collect(parseSSEStream(stringToStream(frame)));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('first\nsecond');
  });

  // ---------- 9. 支持 CRLF 分帧 ----------
  it('支持 CRLF 分帧', async () => {
    const stream = stringToStream('data:{"x":1}\r\n\r\n');
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"x":1}');
  });

  // ---------- 10. 支持 data: 后没有空格 ----------
  it('支持 data: 后没有空格', async () => {
    const stream = stringToStream('data:{"x":1}\n\n');
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"x":1}');
  });

  // ---------- 11. 保留 data 值中除规范单个可选空格以外的空白 ----------
  it('保留 data 值中除规范单个可选空格以外的空白', async () => {
    const stream = stringToStream('data:  leading-space\n\n');
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(1);
    // 一个可选空格被删除，"leading-space" 保留
    expect(events[0].data).toBe(' leading-space');
  });

  // ---------- 12. EOF 前没有空行时丢弃未完成事件 ----------
  it('EOF 前没有空行时丢弃未完成事件', async () => {
    const stream = stringToStream('data: incomplete-without-blank-line');
    const events = await collect(parseSSEStream(stream));

    // 不应该产出未完成的事件
    expect(events).toHaveLength(0);
  });

  // ---------- 13. comment 行被忽略 ----------
  it('忽略 comment 行 (: 开头)', async () => {
    const stream = stringToStream(':comment line\ndata: real\n\n');
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('real');
  });

  // ---------- 14. 事件类型字段保留 ----------
  it('保留 event 和 id 字段', async () => {
    const stream = stringToStream('event: update\nid: 42\ndata: payload\n\n');
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('payload');
    expect(events[0].event).toBe('update');
    expect(events[0].id).toBe('42');
  });

  // ---------- 15. reader lock 在异常路径释放 ----------
  it('异常时仍释放 reader lock', async () => {
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

  // ---------- 16. 多帧跨多个 chunk ----------
  it('多帧跨多个 chunk 正确处理', async () => {
    const f1 = 'data: first\n\n';
    const f2 = 'data: second\n\n';
    const mid = Math.floor(f2.length / 2);

    const stream = chunkedStream([f1 + f2.slice(0, mid), f2.slice(mid)]);
    const events = await collect(parseSSEStream(stream));

    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('first');
    expect(events[1].data).toBe('second');
  });

  // ---------- 17. 仅空白字符流 ----------
  it('仅空白字符的流抛出 SSEParseError', async () => {
    const stream = stringToStream('\n\n  \n\n');
    await expect(collect(parseSSEStream(stream))).rejects.toThrow(SSEParseError);
  });
});
