import type { DeepSeekStreamChunk } from './deepseek-types';

const SSE_DATA_PREFIX = 'data: ';
const SSE_DOUBLE_NEWLINE = '\n\n';
const SSE_DONE_MARKER = '[DONE]';

/**
 * 解析 SSE (Server-Sent Events) 流。
 *
 * 接收 HTTP 响应的 body（ReadableStream），逐 chunk 读取二进制字节，
 * 按 SSE 帧格式解析，yield 每个解析好的 DeepSeekStreamChunk。
 *
 * 粘包/拆包处理：
 * - Chunk 边界不一定对齐 SSE 帧边界
 * - 维护字符串 buffer，追加新 chunk 文本 → 提取完整帧（\n\n 分隔）→ 不完整的留在 buffer
 *
 * 错误策略：
 * - 单行 JSON 解析失败 → 容错跳过，继续后续行
 * - 流整体不是有效 SSE 格式 → 由调用方根据实际情况处理
 *
 * 设计决策：只做 SSE 协议解析，不拼接 tool_calls arguments 片段。
 * 语义聚合由 deepseek-client 负责。
 * 这样 sse-parser 可复用于任何 OpenAI 兼容的 SSE 流。
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<DeepSeekStreamChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (buffer.trim()) {
          const chunk = extractChunkFromFrame(buffer.trimEnd());
          if (chunk) yield chunk;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split(SSE_DOUBLE_NEWLINE);
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const chunk = extractChunkFromFrame(frame);
        if (chunk) yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractChunkFromFrame(frameText: string): DeepSeekStreamChunk | null {
  const dataLines = frameText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith(SSE_DATA_PREFIX));

  if (dataLines.length === 0) return null;

  const jsonStr = dataLines[0].slice(SSE_DATA_PREFIX.length);

  if (jsonStr === SSE_DONE_MARKER) return null;

  try {
    return JSON.parse(jsonStr) as DeepSeekStreamChunk;
  } catch {
    console.warn('[sse-parser] Skipped malformed JSON line:', jsonStr.slice(0, 80));
    return null;
  }
}
