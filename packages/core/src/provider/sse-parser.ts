/**
 * SSE (Server-Sent Events) 协议解析器。
 *
 * 纯协议层：输出通用 SSEEvent，不依赖任何具体 Provider 的 JSON 类型。
 * JSON 解析由 deepseek-client 负责。
 *
 * 解析不变量：
 * 1. UTF-8 增量解码，EOF 时调用一次 decoder.decode() 刷新 decoder
 * 2. CRLF、CR、LF 都视为行结束
 * 3. 空行 dispatch 当前事件
 * 4. `data:` 后只删除一个可选空格，保留其余字符
 * 5. 多条 data 行以 `\n` 拼接
 * 6. EOF 时没有空行结束的 pending event 丢弃
 * 7. comment、未知字段忽略；event 和 id 按规范保留
 */

import { SSEParseError } from './errors.js';

const SSE_DATA_PREFIX = 'data:';
const SSE_DONE_MARKER = '[DONE]';

export interface SSEEvent {
  data: string;
  event?: string;
  id?: string;
}

/**
 * 解析 SSE (Server-Sent Events) 流。
 *
 * 接收 HTTP 响应的 body（ReadableStream），逐 chunk 读取二进制字节，
 * 按 SSE 帧格式解析，yield 每个解析好的 SSEEvent。
 *
 * 粘包/拆包处理：
 * - Chunk 边界不一定对齐 SSE 帧边界
 * - 维护字符串 buffer，追加新 chunk 文本 → 提取完整帧（空行分隔）→ 不完整的留在 buffer
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let yieldedCount = 0;
  let receivedBytes = false;
  let sawDataPrefix = false; // 是否见过 data: 行（用于区分垃圾和 incomplete frame）

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // UTF-8 decoder 刷新：处理可能残留在 decoder 内部状态中的多字节字符
        buffer += decoder.decode();

        // 检查是否包含 SSE data 行标记（用于 EOF 判断）
        if (!sawDataPrefix && /^data:/m.test(buffer)) {
          sawDataPrefix = true;
        }

        // EOF 时没有空行结束的 pending event 丢弃（不变量 #6）
        // 先尝试提取完整帧
        const remainingFrames = extractCompleteFrames(buffer);
        buffer = '';
        for (const frame of remainingFrames) {
          const event = parseEventFromFrame(frame);
          if (event) { yieldedCount++; yield event; }
        }

        // 流整体不是有效 SSE 格式：收到数据但未产出任何 chunk，且从未见过 data: 行
        // 如果是 pending incomplete frame（有 data: 前缀但无空行结束），按规范丢弃
        if (receivedBytes && yieldedCount === 0 && !sawDataPrefix) {
          throw new SSEParseError(
            'Stream contained no valid SSE frames. Expected "data: <value>" lines.',
          );
        }
        return;
      }

      if (value.length > 0) receivedBytes = true;
      buffer += decoder.decode(value, { stream: true });

      // 追踪是否见过 data: 行
      if (!sawDataPrefix && /^data:/m.test(buffer)) {
        sawDataPrefix = true;
      }

      // 按空行分割帧
      const frames = extractCompleteFrames(buffer);
      // 最后一段是不完整帧（留在 buffer）
      buffer = getRemainingBuffer(buffer);

      for (const frame of frames) {
        const event = parseEventFromFrame(frame);
        if (event) { yieldedCount++; yield event; }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ===== 内部函数 =====

/**
 * 从 buffer 中提取完整帧（以空行结束）。
 * 支持 CRLF (\r\n\r\n)、CR (\r\r)、LF (\n\n) 作为帧分隔符。
 * 返回完整帧数组，不包含空行本身。
 */
function extractCompleteFrames(buffer: string): string[] {
  const frames: string[] = [];

  // 查找空行分隔符：优先匹配 \r\n\r\n、\r\r、\n\n
  let remaining = buffer;
  while (remaining.length > 0) {
    // 尝试匹配双换行（各种形式）
    const crlfIdx = remaining.indexOf('\r\n\r\n');
    const lfIdx = remaining.indexOf('\n\n');
    const crIdx = remaining.indexOf('\r\r');

    let sepLen = 0;
    let sepIdx = -1;

    // 选择最早出现的分隔符
    const candidates: Array<[number, number]> = [];
    if (crlfIdx !== -1) candidates.push([crlfIdx, 4]);
    if (lfIdx !== -1) candidates.push([lfIdx, 2]);
    if (crIdx !== -1) candidates.push([crIdx, 2]);

    if (candidates.length === 0) break;

    candidates.sort((a, b) => a[0] - b[0]);
    [sepIdx, sepLen] = candidates[0];

    frames.push(remaining.slice(0, sepIdx));
    remaining = remaining.slice(sepIdx + sepLen);
  }

  return frames;
}

/**
 * 返回 buffer 中最后一个不完整帧的内容。
 * 即最后一个空行分隔符之后的部分。
 */
function getRemainingBuffer(buffer: string): string {
  // 从后往前找最后一个空行分隔符
  const lastCRLF = buffer.lastIndexOf('\r\n\r\n');
  const lastLF = buffer.lastIndexOf('\n\n');
  const lastCR = buffer.lastIndexOf('\r\r');

  const lastSep = Math.max(lastCRLF, lastLF, lastCR);

  if (lastSep === -1) return buffer;

  // 确定分隔符长度
  let sepLen = 2;
  if (lastSep === lastCRLF) sepLen = 4;

  return buffer.slice(lastSep + sepLen);
}

/**
 * 从单帧文本解析 SSEEvent。
 * 忽略 comment 行（以 : 开头）。保留 event 和 id 字段。
 * data: 后只删除一个可选空格（不变量 #4）。
 * 多条 data 行以 \n 拼接（不变量 #5）。
 */
function parseEventFromFrame(frameText: string): SSEEvent | null {
  // 按行分割（支持 \r\n、\r、\n）
  const lines = frameText.split(/\r\n|\r|\n/);

  const dataLines: string[] = [];
  let eventType: string | undefined;
  let eventId: string | undefined;

  for (const rawLine of lines) {
    // comment 行 — 忽略（不变量 #7）
    if (rawLine.startsWith(':')) continue;

    // event 字段
    if (rawLine.startsWith('event:')) {
      eventType = extractFieldValue(rawLine, 'event:');
      continue;
    }

    // id 字段
    if (rawLine.startsWith('id:')) {
      eventId = extractFieldValue(rawLine, 'id:');
      continue;
    }

    // data 字段 — 只删除一个可选空格（不变量 #4）
    if (rawLine.startsWith(SSE_DATA_PREFIX)) {
      let value = rawLine.slice(5); // 移除 "data:"
      if (value.startsWith(' ')) {
        value = value.slice(1); // 只删除一个可选空格
      }
      dataLines.push(value);
      continue;
    }

    // 未知字段 — 忽略（不变量 #7）
  }

  if (dataLines.length === 0) return null;

  // 多条 data 行以 \n 拼接（不变量 #5）
  const data = dataLines.join('\n');

  // [DONE] 标记不作为事件产出
  if (data === SSE_DONE_MARKER) return null;

  const event: SSEEvent = { data };
  if (eventType) event.event = eventType;
  if (eventId) event.id = eventId;

  return event;
}

/** 提取字段值：移除前缀，再移除一个可选空格 */
function extractFieldValue(line: string, prefix: string): string {
  let value = line.slice(prefix.length);
  if (value.startsWith(' ')) {
    value = value.slice(1);
  }
  return value;
}
